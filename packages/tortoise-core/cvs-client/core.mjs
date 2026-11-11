// biome-ignore-all lint/suspicious/noControlCharactersInRegex: CVS protocol validation must reject C0 bytes.
import { spawn } from "node:child_process";
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import {
  assertOwnedPath,
  boundariesForPaths,
  isCvsContinuation,
  NestedRepositoryError,
  readCvsEntries,
  registeredCvsDirectories,
  repositoryTree,
} from "../repositories/boundaries.cjs";
import { runNetwork } from "../repositories/network.cjs";
import { rootPath } from "./cache.mjs";
import {
  decodeBytes,
  logDate,
  logRangeArgs,
  parseLogDate,
  parseRepositoryLog,
  rlogPath,
  uniqueRevisions,
} from "./log.mjs";

// CVS 1.12 内置忽略表（ignore.c 的 ign_default）。
const DEFAULT_IGNORE =
  ". .. core RCSLOG tags TAGS RCS SCCS .make.state .nse_depinfo #* .#* cvslog.* ,* CVS CVS.adm .del-* *.a *.olb *.o *.obj *.so *.Z *~ *.old *.elc *.ln *.bak *.BAK *.orig *.rej *.exe _$* *$".split(
    " ",
  );
// 规则文件路径 → 模式与已编译匹配器；mtime、ctime 或大小变化即重读。
const ignoreFiles = new Map();
let globalIgnoreCache;
// POSIX 字符类固定使用 C locale 的 ASCII 范围。
const POSIX_CLASSES = {
  alpha: "A-Za-z",
  digit: "0-9",
  alnum: "A-Za-z0-9",
  upper: "A-Z",
  lower: "a-z",
  space: "\\x09-\\x0d\\x20",
  blank: "\\x09\\x20",
  punct: "\\x21-\\x2f\\x3a-\\x40\\x5b-\\x60\\x7b-\\x7e",
  xdigit: "0-9A-Fa-f",
  cntrl: "\\x00-\\x1f\\x7f",
  print: "\\x20-\\x7e",
  graph: "\\x21-\\x7e",
};
// fnmatch(3) 无标志语义：* 与 ? 也匹配开头的点；方括号支持 ! 取反与范围；反斜杠转义下一个字符。
function globSource(pattern) {
  const literal = (char) => char.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  let source = "";
  for (let i = 0; i < pattern.length; i++) {
    const char = pattern[i];
    if (char === "*") source += "[^]*";
    else if (char === "?") source += "[^]";
    else if (char === "\\" && i + 1 < pattern.length)
      source += literal(pattern[++i]);
    else if (char === "[") {
      let end = i + 1;
      if (pattern[end] === "!" || pattern[end] === "^") end++;
      if (pattern[end] === "]") end++;
      while (end < pattern.length && pattern[end] !== "]") {
        const named = /^\[:[a-z]+:\]/.exec(pattern.slice(end));
        end += named ? named[0].length : pattern[end] === "\\" ? 2 : 1;
      }
      if (end >= pattern.length) {
        source += "\\[";
        continue;
      }
      let body = "",
        j = i + 1;
      if (pattern[j] === "!" || pattern[j] === "^") {
        body = "^";
        j++;
      }
      for (; j < end; j++) {
        const named = /^\[:([a-z]+):\]/.exec(pattern.slice(j));
        if (named) {
          const chars = POSIX_CLASSES[named[1]];
          // fnmatch 遇未知类停止尝试：此前已匹配的正向成员仍有效，取反类不匹配。
          if (!Object.hasOwn(POSIX_CLASSES, named[1])) {
            if (body.startsWith("^")) body = "";
            break;
          }
          body += chars;
          j += named[0].length - 1;
          // 字符类不能充当范围端点；紧随它的 - 是普通成员。
          if (pattern[j + 1] === "-") {
            body += "\\-";
            j++;
          }
          continue;
        }
        body +=
          pattern[j] === "\\"
            ? literal(pattern[++j])
            : pattern[j] === "-"
              ? "-"
              : literal(pattern[j]);
      }
      source += `[${body}]`;
      i = end;
    } else source += literal(char);
  }
  return source;
}
// 按顺序叠加；单独的 ! 清空此前规则，CVS 仍保留 CVS 目录本身。无效范围（如 [z-a]）不匹配任何名字。
function ignoreMatcher(patterns) {
  let active = [];
  for (const pattern of patterns)
    if (pattern === "!") active = ["CVS"];
    else active.push(pattern);
  const sources = active.map(globSource).filter((source) => {
    try {
      RegExp(source);
      return true;
    } catch {
      return false;
    }
  });
  const expression = new RegExp(`^(?:${sources.join("|")})$`);
  return (name) => expression.test(name);
}
// 读不到的规则文件按不存在处理，与 CVS 只警告后继续一致。
async function ignoreFile(file) {
  const stat = await fs.stat(file).catch(() => undefined);
  if (!stat?.isFile()) {
    ignoreFiles.delete(file);
    return undefined;
  }
  const key = `${stat.mtimeMs}:${stat.ctimeMs}:${stat.size}`;
  let cached = ignoreFiles.get(file);
  if (cached?.key !== key) {
    const text = await fs.readFile(file, "utf8").catch(() => "");
    cached = { key, patterns: text.split(/\s+/).filter(Boolean) };
    ignoreFiles.set(file, cached);
  }
  return cached;
}
// CVS 客户端顺序：内置表 → ~/.cvsignore → CVSIGNORE；家目录与 CVS 1.12 相同先取 HOME。
// 服务器端 CVSROOT/cvsignore 要连网，本地清单不读。
async function globalIgnore() {
  const home = await ignoreFile(
    path.join(process.env.HOME || os.homedir(), ".cvsignore"),
  );
  const user = [
    ...(home?.patterns ?? []),
    ...(process.env.CVSIGNORE ?? "").split(/\s+/).filter(Boolean),
  ];
  const patterns = [...DEFAULT_IGNORE, ...user];
  const key = patterns.join("\n");
  if (globalIgnoreCache?.key !== key)
    globalIgnoreCache = {
      key,
      patterns,
      inhibit: user.includes("!"),
      test: ignoreMatcher(patterns),
    };
  return globalIgnoreCache;
}
// 目录自己的 .cvsignore 只作用于该目录下的名字，不继承到子目录。
// pserver 下客户端未忽略的名字再由服务器按内置表判断，目录里的 ! 清不掉它；只有 ~/.cvsignore 或 CVSIGNORE 的 ! 让服务器也不忽略。
async function directoryIgnore(global, directory, remote, present = true) {
  const local =
    present && (await ignoreFile(path.join(directory, ".cvsignore")));
  if (!local) return global.test;
  const server = remote && !global.inhibit;
  if (local.global !== global.key || local.server !== server) {
    Object.assign(local, { global: global.key, server });
    local.test = ignoreMatcher([
      ...global.patterns,
      ...local.patterns,
      ...(server ? DEFAULT_IGNORE : []),
    ]);
  }
  return local.test;
}
export class CvsError extends Error {
  constructor(code) {
    super(code);
    this.code = code;
  }
}
export function fail(code) {
  throw new CvsError(code);
}
export function revision(value) {
  if (
    typeof value !== "string" ||
    !/^[1-9]\d*(?:\.\d+)+$/.test(value) ||
    value.length > 100
  )
    fail("revision");
  return value;
}
export function relativeFile(value) {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2048 ||
    /[\x00-\x1f\x7f\\\\]/.test(value) ||
    path.isAbsolute(value) ||
    value
      .split("/")
      .some((s) => !s || s === "." || s === ".." || s.toLowerCase() === "cvs")
  )
    fail("path");
  return value;
}
export function cvsRoot(value) {
  if (
    typeof value !== "string" ||
    value.length > 2048 ||
    /[\x00-\x1f\x7f]/.test(value)
  )
    fail("root");
  if (
    /^:local:\//.test(value) ||
    /^\//.test(value) ||
    // 端口后可直接接路径（CVS 1.12：host:2401/path），也可再带冒号（CVSNT：host:2401:/path）。
    /^:pserver:(?:[\w.-]+@)?[\w.-]+(?::\d{1,5}:?|:)\/[^\s]+$/.test(value)
  )
    return value;
  fail("root");
}
export async function noSymlinks(target, allowMissing = false) {
  const absolute = path.resolve(target);
  let current = path.parse(absolute).root;
  for (const segment of absolute
    .slice(current.length)
    .split(path.sep)
    .filter(Boolean)) {
    current = path.join(current, segment);
    try {
      if ((await fs.lstat(current)).isSymbolicLink()) fail("symlink");
    } catch (error) {
      // 缺的目录之下什么都不存在，也就没有符号链接可查。
      if (allowMissing && error.code === "ENOENT") return absolute;
      throw error;
    }
  }
  return absolute;
}
export async function contained(root, relative, allowMissing = true) {
  relativeFile(relative);
  const canonicalRoot = await fs.realpath(root);
  const target = path.join(canonicalRoot, relative);
  if (!target.startsWith(canonicalRoot + path.sep)) fail("path");
  await noSymlinks(target, allowMissing);
  return target;
}
export async function findWorkingCopy(start) {
  let current = await fs.realpath(start);
  if (!(await fs.stat(current)).isDirectory()) current = path.dirname(current);
  let found;
  for (;;) {
    try {
      await noSymlinks(path.join(current, "CVS", "Root"));
      await fs.access(path.join(current, "CVS", "Entries"));
      if (!found) {
        // A CVS working copy has administrative metadata in every ordinary
        // descendant.  Keep walking only while that metadata represents the
        // same checkout; an independent checkout below a parent must remain
        // its own working-copy root.
        found = current;
      } else if (await isCvsContinuation(current, found)) {
        found = current;
      } else {
        break;
      }
    } catch (error) {
      if (error instanceof CvsError) throw error;
      if (found) break;
    }
    const parent = path.dirname(current);
    if (parent === current) break;
    current = parent;
  }
  if (!found) fail("workingCopy");
  return found;
}

export class CvsProcess {
  constructor(
    executable = "cvs",
    { timeoutMs = 60000, maxBytes = 16 * 1024 * 1024 } = {},
  ) {
    this.executable = executable;
    this.timeoutMs = timeoutMs;
    this.maxBytes = maxBytes;
  }
  run(args, cwd, signal, allowed = [0], options = {}) {
    return runNetwork(
      () => this.execute(args, cwd, signal, allowed, options),
      signal,
    );
  }
  async execute(args, cwd, signal, allowed, options) {
    await options.beforeStart?.();
    if (signal?.aborted) return Promise.reject(new CvsError("cancelled"));
    return new Promise((resolve, reject) => {
      const env = { ...process.env, LC_ALL: "C", LANG: "C" };
      // CVSIGNORE 保留，网络刷新的 ? 行与本地清单用同一套忽略规则。
      for (const key of Object.keys(env))
        if (/^(CVS|RCS)/.test(key) && key !== "CVSIGNORE") delete env[key];
      const child = spawn(this.executable, ["-f", ...args], {
        cwd,
        env,
        shell: false,
        detached: process.platform !== "win32",
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = [],
        stderr = [],
        combined = [],
        size = 0,
        reason,
        killTimer;
      const kill = (signal) => {
        try {
          if (process.platform !== "win32" && child.pid)
            process.kill(-child.pid, signal);
          else child.kill(signal);
        } catch (error) {
          if (error.code !== "ESRCH") child.kill(signal);
        }
      };
      const stop = (code) => {
        reason ??= code;
        kill("SIGTERM");
        killTimer ??= setTimeout(() => kill("SIGKILL"), 1000);
      };
      const abort = () => stop("cancelled");
      const timer = setTimeout(
        () => stop("timeout"),
        options.timeoutMs ?? this.timeoutMs,
      );
      signal?.addEventListener("abort", abort, { once: true });
      const clean = () => {
        clearTimeout(timer);
        clearTimeout(killTimer);
        signal?.removeEventListener("abort", abort);
      };
      const append = (stream, data) => {
        size += data.length;
        if (size > (options.maxBytes ?? this.maxBytes)) stop("outputLimit");
        else {
          if (stream === "stdout") stdout.push(data);
          else stderr.push(data);
          if (!options.stdoutOnly) combined.push(data);
        }
      };
      child.stdout.on("data", (data) => append("stdout", data));
      child.stderr.on("data", (data) => append("stderr", data));
      child.on("error", (error) => {
        clean();
        reject(
          new CvsError(error.code === "ENOENT" ? "missingClient" : "process"),
        );
      });
      child.on("close", (code) => {
        clean();
        if (reason) reject(new CvsError(reason));
        else if (!allowed.includes(code)) reject(new CvsError("command"));
        else
          resolve({
            stdout: Buffer.concat(options.stdoutOnly ? stdout : combined),
            stderr: Buffer.concat(stderr),
            code,
          });
      });
    });
  }
}
export class SerialQueue {
  tail = Promise.resolve();
  controllers = new Set();
  run(job) {
    const controller = new AbortController();
    this.controllers.add(controller);
    const next = this.tail.then(() => {
      if (controller.signal.aborted) fail("cancelled");
      return job(controller.signal);
    });
    this.tail = next.catch(() => {});
    return next.finally(() => this.controllers.delete(controller));
  }
  cancel() {
    for (const controller of this.controllers) controller.abort();
  }
}
// text 可以是按 latin1 读入的原始字节；decode 逐字段解码（见 log.mjs 的 decodeBytes）。
export function parseLog(text, decode = (value) => value) {
  const symbols = [
    ...(
      text.match(/symbolic names:\r?\n([\s\S]*?)keyword substitution:/)?.[1] ||
      ""
    ).matchAll(/^\s+([^:\r\n]+):\s+(\d+(?:\.\d+)+)\s*$/gm),
  ].map((match) => {
    const raw = match[2],
      parts = raw.split(".");
    if (parts.length >= 4 && parts.at(-2) === "0") parts.splice(-2, 1);
    return {
      name: decode(match[1]),
      raw,
      number: parts.join("."),
      branch: parts.length % 2 === 1,
    };
  });
  const defaultBranch =
    text.match(/^branch:[ \t]*([^\r\n]*)/m)?.[1]?.trim() || "1";
  return text
    .split(/^----------------------------\r?$/m)
    .slice(1)
    .flatMap((block) => {
      const match = block.match(
        /^\r?\nrevision (\d+(?:\.\d+)+)\r?\ndate: ([^;]+);\s+author: ([^;]+);\s+state: ([^;]+);[^\r\n]*\r?\n([\s\S]*)/,
      );
      if (!match) return [];
      const message = decode(match[5])
          .replace(/^branches:[^\n]*\n/, "")
          .replace(/\n={20,}[\s\S]*$/, "")
          .trim(),
        parts = match[1].split("."),
        branchId = parts.slice(0, -1).join("."),
        branchNames = symbols
          .filter((symbol) => symbol.branch && symbol.number === branchId)
          .map((symbol) => symbol.name),
        references = symbols
          .filter((symbol) =>
            symbol.branch
              ? symbol.number === branchId
              : symbol.number === match[1],
          )
          .map((symbol) => ({
            name: symbol.name,
            kind: symbol.branch ? "branch" : "tag",
          })),
        branches = (match[5].match(/^branches:\s*([^\n]*)/)?.[1] || "")
          .split(";")
          .map((s) => s.trim())
          .filter(Boolean);
      return [
        {
          branchId,
          branchNames,
          defaultBranch,
          branches,
          references,
          revisionId: match[1],
          timestamp: match[2],
          author: { name: decode(match[3]) },
          state: match[4],
          subject: message.split("\n")[0] || "(empty)",
          body: message.split("\n").slice(1).join("\n"),
        },
      ];
    });
}
export function parseStatus(text) {
  const state = text.match(/\bStatus: ([^\r\n]+)/)?.[1]?.trim();
  if (!state) fail("parse");
  const workingRevision = text.match(
      /Working revision:\s*(-?\d+(?:\.\d+)*)/,
    )?.[1],
    repositoryRevision = text.match(
      /Repository revision:\s*(\d+(?:\.\d+)*)/,
    )?.[1];
  return {
    state,
    workingRevision,
    repositoryRevision,
    status:
      {
        "Locally Modified": "modified",
        "Locally Added": "added",
        "Locally Removed": "deleted",
        "File had conflicts on merge": "conflicts",
        "Needs Merge": "conflicts",
        "Needs Patch": "modified",
        "Needs Checkout": "modified",
      }[state] || "",
  };
}
export function parseUpdateStatus(text) {
  const states = {
    M: "Locally Modified",
    A: "Locally Added",
    R: "Locally Removed",
    C: "Needs Merge",
    U: "Needs Checkout",
    P: "Needs Patch",
    "?": "Unknown",
  };
  const result = new Map();
  for (const line of text.split(/\r?\n/)) {
    const match = line.match(/^([MARCUP?]) (.+)$/);
    const notice = line.match(
      /^cvs(?:\.exe)? (?:update|server): (?:warning: )?(?:conflicts found in (.+)|[`'](.+)['`] (?:was lost|is no longer in the repository))$/,
    );
    const name = match?.[2] ?? notice?.[1] ?? notice?.[2];
    if (!name) continue;
    const state = match
      ? states[match[1]]
      : notice[1]
        ? "Needs Merge"
        : "Needs Checkout";
    // 复用逐文件状态映射，避免只读刷新与提交校验的显示语义分叉。
    result.set(
      name.replace(/\\/g, "/").replace(/^\.\//, ""),
      parseStatus(`Status: ${state}`),
    );
  }
  return result;
}
export class CvsAdapter {
  constructor(root, process = new CvsProcess()) {
    this.root = root;
    this.process = process;
    this.cleanSizes = new Map();
    this.remoteStates = new Map();
    // 修订内容缓存（由会话设置）：{ read(path, revision), write(path, revision, bytes) }，修订不可变。
    this.contentCache = undefined;
  }
  async inventory() {
    const { files } = await this.localInventory();
    return files.map(({ timestamp, ...file }) => file);
  }
  async localInventory() {
    this.root = await fs.realpath(this.root);
    await noSymlinks(this.root);
    const tree = await repositoryTree(this.root, this.root, {
      managedOnly: true,
    });
    this.lastNestedBoundaries = tree.nested;
    const files = [],
      unknown = [],
      global = await globalIgnore();
    for (const { directory, entries, cvs } of tree.directories) {
      if (!cvs) {
        const relative = path
          .relative(this.root, directory)
          .split(path.sep)
          .join("/");
        // 未管理目录由所在目录的规则判断。
        const test = await directoryIgnore(
          global,
          path.dirname(directory),
          this.remote(),
        );
        if (relative && !test(path.basename(directory)))
          unknown.push(relativeFile(relative) + "/");
        continue;
      }
      const root = cvsRoot(cvs.Root);
      this.repositoryRoot ??= root;
      if (root !== this.repositoryRoot) fail("root");
      if (/[\x00-\x1f]/.test(cvs.Repository)) fail("path");
      const relative = path
        .relative(this.root, directory)
        .split(path.sep)
        .join("/");
      const prefix = relative ? relative + "/" : "";
      const names = new Set();
      for (const record of cvs.Entries)
        if (record.startsWith("/")) {
          const fields = record.split("/"),
            newPath = relativeFile(prefix + fields[1]);
          names.add(fields[1]);
          files.push({
            newPath,
            entryRevision: fields[2],
            timestamp: fields[3],
          });
          if (files.length > 20000) fail("inventoryLimit");
        }
      // 管理文件及目录必须仍为普通文件；树遍历已排除管理树和子仓。
      for (const entry of await fs.readdir(path.join(directory, "CVS"), {
        withFileTypes: true,
      }))
        if (entry.isSymbolicLink()) fail("symlink");
      // 按 CVS 忽略规则跳过 .#*（更新冲突与回滚留下的备份）、*.o、.cvsignore 所列等；只有目录里有 .cvsignore 才读它。
      const test = await directoryIgnore(
        global,
        directory,
        this.remote(),
        entries.some((entry) => entry.name === ".cvsignore"),
      );
      for (const entry of entries) {
        if (entry.isSymbolicLink()) fail("symlink");
        if (entry.isFile() && !names.has(entry.name) && !test(entry.name))
          unknown.push(relativeFile(prefix + entry.name));
      }
    }
    files.sort((a, b) => a.newPath.localeCompare(b.newPath));
    return { files, unknown };
  }
  // 日志的文件清单：沿 Entries 的 D/ 记录走已登记目录，只读 Entries/Entries.Log，不 lstat 文件、不执行 CVS。
  async entryNames() {
    this.root = await fs.realpath(this.root);
    const names = [];
    for (const directory of await registeredCvsDirectories(this.root)) {
      const prefix = directory === "." ? "" : `${directory.slice(2)}/`;
      for (const record of await this.entriesAt(
        path.join(this.root, directory),
      ))
        if (record.startsWith("/"))
          names.push(relativeFile(prefix + record.split("/")[1]));
    }
    return names.sort((a, b) => a.localeCompare(b));
  }
  remote() {
    return this.repositoryRoot?.startsWith(":pserver:") ?? false;
  }
  async entriesAt(directory) {
    const admin = path.join(directory, "CVS");
    await noSymlinks(path.join(admin, "Root"));
    const root = cvsRoot(
      (await fs.readFile(path.join(admin, "Root"), "utf8")).trim(),
    );
    this.repositoryRoot ??= root;
    if (root !== this.repositoryRoot) fail("root");
    return readCvsEntries(directory);
  }
  async localStatus(names) {
    if (names) {
      const result = [],
        global = await globalIgnore();
      for (const name of names) {
        relativeFile(name);
        await contained(this.root, name);
        await assertOwnedPath(this.root, "cvs", name);
        const directory = path.dirname(path.join(this.root, name));
        const hasAdmin = await fs
          .lstat(path.join(directory, "CVS"))
          .catch((error) => {
            if (error.code !== "ENOENT") throw error;
          });
        const records = hasAdmin ? await this.entriesAt(directory) : [];
        const entry = records.find((line) =>
          line.startsWith(`/${path.basename(name)}/`),
        );
        if (entry) {
          const fields = entry.split("/");
          result.push(
            this.withRemote(
              await this.localFile({
                newPath: name,
                entryRevision: fields[2],
                timestamp: fields[3],
              }),
            ),
          );
        } else {
          const stat = await fs
            .lstat(path.join(this.root, name))
            .catch((error) => {
              if (error.code !== "ENOENT") throw error;
            });
          if (
            stat?.isFile() &&
            !(await directoryIgnore(global, directory, this.remote()))(
              path.basename(name),
            )
          )
            result.push({
              newPath: name,
              entryRevision: "",
              state: "Unknown",
              status: "untracked",
            });
        }
      }
      return result;
    }
    const { files, unknown } = await this.localInventory();
    const listed = new Set([...files.map((file) => file.newPath), ...unknown]);
    const result = [];
    for (let start = 0; start < files.length; start += 32)
      result.push(
        ...(await Promise.all(
          files
            .slice(start, start + 32)
            .map(async (file) => this.withRemote(await this.localFile(file))),
        )),
      );
    // 最近一次网络结果中服务器新增、本地仍没有的文件继续列为传入。
    for (const [newPath, remote] of this.remoteStates)
      if (remote.state === "Needs Checkout" && !listed.has(newPath))
        result.push({ newPath, entryRevision: "", ...remote });
    return [
      ...result,
      ...unknown.map((newPath) => ({
        newPath,
        entryRevision: "",
        state: "Unknown",
        status: "untracked",
      })),
    ];
  }
  withRemote(file) {
    const remote = this.remoteStates.get(file.newPath);
    if (!remote) return file;
    if (file.state === "Up-to-date") return { ...file, ...remote };
    if (
      file.state === "Locally Modified" &&
      ["Needs Checkout", "Needs Patch", "Needs Merge"].includes(remote.state)
    )
      return { ...file, ...parseStatus("Status: Needs Merge") };
    return file;
  }
  async localFile({ timestamp, ...file }) {
    const stat = await fs
      .lstat(path.join(this.root, file.newPath))
      .catch((error) => {
        if (error.code !== "ENOENT") throw error;
      });
    if (stat && !stat.isFile()) fail("symlink");
    let state;
    if (file.entryRevision === "0") state = "Locally Added";
    else if (file.entryRevision.startsWith("-")) state = "Locally Removed";
    else if (!stat) state = "Missing";
    else if (timestamp?.includes("+")) {
      // 与 CVS 相同：合并后文件未再改动才算冲突；编辑解决后为本地修改，残留冲突标记由 cvs commit 拒绝。
      const merged = Date.parse(`${timestamp.split("+")[1]} GMT`);
      state =
        !Number.isFinite(merged) ||
        Math.floor(stat.mtimeMs / 1000) === Math.floor(merged / 1000)
          ? "File had conflicts on merge"
          : "Locally Modified";
    } else {
      // CVS Entries 使用 UTC asctime，时间精度为秒；无可证明基线时保守列为修改。
      const recorded = Date.parse(`${timestamp} GMT`);
      const key = `${file.newPath}\0${file.entryRevision}\0${timestamp}`;
      const sizeMatches =
        !this.cleanSizes.has(key) || this.cleanSizes.get(key) === stat.size;
      const unchanged =
        sizeMatches &&
        Number.isFinite(recorded) &&
        Math.floor(stat.mtimeMs / 1000) === Math.floor(recorded / 1000);
      if (unchanged) this.cleanSizes.set(key, stat.size);
      state = unchanged ? "Up-to-date" : "Locally Modified";
    }
    return {
      ...file,
      mtimeMs: stat?.mtimeMs,
      ...parseStatus(`Status: ${state}`),
      status:
        state === "Missing"
          ? "deleted"
          : parseStatus(`Status: ${state}`).status,
    };
  }
  getNestedBoundaries() {
    // Inventory already performs the bounded operation-time walk.  Returning
    // that snapshot lets a page render boundary hints without turning a UI
    // refresh into another recursive filesystem scan.
    return [...(this.lastNestedBoundaries ?? [])];
  }
  async file(name) {
    relativeFile(name);
    await contained(this.root, name);
    await assertOwnedPath(this.root, "cvs", name);
    const records = await this.entriesAt(
      path.dirname(path.join(this.root, name)),
    );
    const entry = records.find((line) =>
      line.startsWith(`/${path.basename(name)}/`),
    );
    if (!entry) fail("path");
    return { newPath: name, entryRevision: entry.split("/")[2] };
  }
  async run(args, signal, allowed, options) {
    return this.process.run(args, this.root, signal, allowed, options);
  }
  async status(signal, local) {
    const files = local ?? (await this.localStatus());
    const output = await this.run(["-n", "-q", "update"], signal, [0, 1], {
      timeoutMs: 180000,
    });
    const text = output.stdout.toString("utf8");
    // 工作副本有未解决冲突时 cvs -n update 以 1 退出；仅在输出含冲突行且未中止时接受。
    if (output.code === 1 && (!/^C /m.test(text) || /aborted\]/.test(text)))
      fail("command");
    const states = parseUpdateStatus(text);
    const result = files
      .filter((file) => file.state !== "Unknown")
      // 本地删掉的已登记文件，update 报 U／was lost；保持本地删除，提交时再 cvs remove。
      .map((file) =>
        file.state === "Missing" &&
        states.get(file.newPath)?.state === "Needs Checkout"
          ? file
          : {
              ...file,
              ...(states.get(file.newPath)?.state === "Needs Merge" &&
              file.state === "File had conflicts on merge"
                ? parseStatus("Status: File had conflicts on merge")
                : (states.get(file.newPath) ??
                  parseStatus("Status: Up-to-date"))),
            },
      );
    const known = new Set(result.map((file) => file.newPath));
    for (const [name, state] of states) {
      if (
        known.has(name) ||
        !["Unknown", "Needs Checkout"].includes(state.state)
      )
        continue;
      try {
        relativeFile(name);
        await contained(this.root, name);
        await assertOwnedPath(this.root, "cvs", name);
        const stat = await fs.lstat(path.join(this.root, name));
        if (state.state !== "Unknown") continue;
        const candidates = stat.isDirectory()
          ? [`${name}/`]
          : stat.isFile()
            ? [name]
            : [];
        for (const file of candidates)
          result.push({
            newPath: file,
            entryRevision: "",
            ...state,
            status: "untracked",
          });
      } catch (error) {
        // 服务器新增、本地还没有的文件（U）：列为传入，更新时取得。
        if (error.code === "ENOENT" && state.state === "Needs Checkout") {
          result.push({ newPath: name, entryRevision: "", ...state });
          continue;
        }
        if (error.code === "BOUNDARY_UNAVAILABLE") throw error;
        if (
          !["NESTED_REPOSITORY", "path", "symlink", "ENOENT"].includes(
            error.code,
          )
        )
          throw error;
      }
    }
    this.remoteStates = new Map(
      result
        .filter((file) =>
          [
            "Needs Checkout",
            "Needs Patch",
            "Needs Merge",
            "File had conflicts on merge",
          ].includes(file.state),
        )
        .map((file) => [file.newPath, parseStatus(`Status: ${file.state}`)]),
    );
    return result.sort((a, b) => a.newPath.localeCompare(b.newPath));
  }
  async add(names, signal) {
    for (const name of names) {
      await contained(this.root, relativeFile(name), false);
      await assertOwnedPath(this.root, "cvs", name);
      await this.run(["add", "./" + name], signal);
    }
  }
  /**
   * 修订查询的路径门：路径在本工作副本内、没有符号链接、不属于嵌套的另一个检出。
   * 文件和所在目录可以不在本地（同事新建的目录、已被删除的文件）：修订一律向服务器端取。
   */
  async revisionFile(name) {
    relativeFile(name);
    await contained(this.root, name);
    await assertOwnedPath(this.root, "cvs", name);
  }
  /**
   * 服务器端读取所需的工作副本信息：CVS/Root（已校验）、相对 CVSROOT 的模块路径（CVS/Repository）、
   * 粘性分支标签。调用 cvs 时用 -d <Root> 明确指定，不依赖当前目录。
   */
  async identity() {
    this.root = await fs.realpath(this.root);
    const admin = path.join(this.root, "CVS");
    const read = async (name, optional = false) => {
      const file = path.join(admin, name);
      await noSymlinks(file, optional);
      try {
        return (await fs.readFile(file, "utf8")).trim();
      } catch (error) {
        if (optional && error.code === "ENOENT") return "";
        throw error;
      }
    };
    const root = cvsRoot(await read("Root"));
    let repository = (await read("Repository")).replace(/\/+$/, "");
    const base = rootPath(root);
    if (base && repository.startsWith(`${base}/`))
      repository = repository.slice(base.length + 1);
    relativeFile(repository);
    const tag = await read("Tag", true);
    const branch = /^T([A-Za-z][\w-]*)$/.exec(tag)?.[1] ?? "";
    return { root, repository, tag, branch, workingCopy: this.root };
  }
  /** 服务器端命令：cvs -d <Root> rlog|checkout …，不依赖本地目录。 */
  async server(identity, args, signal, options = {}) {
    return this.run(["-d", identity.root, ...args], signal, [0], options);
  }
  /**
   * 整个模块的文件修订（服务器端 cvs rlog，只读），每个 path@revision 一条：一条命令覆盖整个模块，
   * 包括本地没有的目录和已删除（Attic）的文件，路径换算成相对工作副本根。粘性分支标签用 -r。
   * from／to 为毫秒时间戳，限定 -d 日期范围（含两端）。
   */
  async repositoryLog({ from, to } = {}, signal) {
    const id = await this.identity();
    const output = await this.server(
      id,
      [
        "rlog",
        "-N",
        "-S",
        ...logRangeArgs({ from, to }),
        ...(id.branch ? [`-r${id.branch}`] : []),
        id.repository,
      ],
      signal,
      // 全部历史可能很大：放宽输出与时间上限，只取 stdout（stderr 的 Logging 行会混进说明）。
      { stdoutOnly: true, timeoutMs: 300000, maxBytes: 128 * 1024 * 1024 },
    );
    const base = rootPath(id.root);
    return uniqueRevisions(
      parseRepositoryLog(output.stdout, (rcs) =>
        rlogPath(rcs, base, id.repository),
      ).filter((item) => {
        try {
          relativeFile(item.path);
          return true;
        } catch {
          return false;
        }
      }),
    );
  }
  /** 单个文件的全部修订（服务器端 rlog），文件不必在本地 Entries 或本地目录里。 */
  async log(name, signal) {
    await this.revisionFile(name);
    const id = await this.identity();
    const output = await this.server(
      id,
      ["rlog", `${id.repository}/${name}`],
      signal,
      { stdoutOnly: true },
    );
    return parseLog(output.stdout.toString("latin1"), decodeBytes).map(
      (item) => ({
        ...item,
        timestamp: Number.isNaN(parseLogDate(item.timestamp))
          ? item.timestamp
          : logDate(parseLogDate(item.timestamp)),
      }),
    );
  }
  /**
   * 修订内容：先看落盘缓存；dead 修订（文件在该修订被删除）为空内容；其余用服务器端
   * cvs checkout -p -r <rev> <模块>/<路径> 读取，不依赖本地目录。revisions 为已知的该文件历史（可省略）。
   */
  async content(name, rev, signal, options = {}) {
    revision(rev);
    await this.revisionFile(name);
    const cached = await this.contentCache?.read(name, rev);
    if (cached) return cached;
    const item = (
      options.revisions
        ? await options.revisions()
        : await this.log(name, signal)
    ).find((entry) => entry.revisionId === rev);
    if (!item) fail("revision");
    if (item.state === "dead") return Buffer.alloc(0);
    const id = await this.identity();
    const bytes = (
      await this.server(
        id,
        ["checkout", "-p", "-r", rev, `${id.repository}/${name}`],
        signal,
        { stdoutOnly: true, maxBytes: options.maxBytes },
      )
    ).stdout;
    await this.contentCache?.write(name, rev, bytes);
    return bytes;
  }
  /** names 中本地工作副本里有的文件（所在目录已登记且 Entries 里有该文件）。 */
  async localFiles(names) {
    const present = new Set(),
      directories = new Map();
    for (const name of names) {
      const directory = path.posix.dirname(name);
      if (!directories.has(directory))
        directories.set(
          directory,
          await this.entriesAt(
            path.join(this.root, directory === "." ? "" : directory),
          ).then(
            (records) =>
              new Set(
                records
                  .filter((line) => line.startsWith("/"))
                  .map((line) => line.split("/")[1]),
              ),
            () => new Set(),
          ),
        );
      if (directories.get(directory).has(path.posix.basename(name)))
        present.add(name);
    }
    return present;
  }
  async diff(name, signal) {
    await this.file(name);
    return (
      await this.run(["diff", "-u", "./" + name], signal, [0, 1])
    ).stdout.toString("utf8");
  }
  async update(signal) {
    if (signal?.aborted) fail("cancelled");
    this.root = await fs.realpath(this.root);
    const directories = await registeredCvsDirectories(this.root);
    // 保留原有符号链接保护，但只检查本次更新目录及其管理文件。
    for (const directory of directories) {
      if (signal?.aborted) fail("cancelled");
      const target = path.join(this.root, directory);
      for (const location of [target, path.join(target, "CVS")])
        for (const entry of await fs.readdir(location, { withFileTypes: true }))
          if (entry.isSymbolicLink()) fail("symlink");
    }
    const flags = ["-q", "update", "-l", "-P"];
    const conflicts = new Set();
    for (const args of this.batches(flags, directories)) {
      if (signal?.aborted) fail("cancelled");
      const output = await this.run([...flags, ...args], signal);
      for (const [name, state] of parseUpdateStatus(
        output.stdout.toString("utf8"),
      ))
        if (state.state === "Needs Merge") conflicts.add(name);
    }
    // -l 不会创建服务器上新建的目录：另外找出它们，逐个用 -d 取下整棵新子树。
    const created = await this.newDirectories(directories, signal);
    const createFlags = ["-q", "update", "-d", "-P"];
    for (const args of this.batches(createFlags, created)) {
      if (signal?.aborted) fail("cancelled");
      await this.run([...createFlags, ...args], signal);
    }
    // 更新已取得的传入不再沿用旧网络结果；随后的网络刷新重新确认。
    this.remoteStates = new Map();
    return [...conflicts];
  }
  /**
   * 服务器上新建、本地还没有的目录（相对工作副本根的 ./路径）：服务器端 rlog -R 列出模块里全部 RCS 文件，
   * 取有未删除文件的目录，只保留“父目录已登记、自己没登记、本地磁盘上也不存在”的最上层目录。
   * 本地已有同名目录（未登记的目录、嵌套的异 Root 检出、符号链接）一律不碰，保持只在已登记目录内动手的边界；
   * 新目录下面的整棵子树本来就不存在于本地，由 update -d 一次取下。
   */
  async newDirectories(registeredDirectories, signal) {
    const id = await this.identity();
    const output = await this.server(
      id,
      [
        "rlog",
        "-R",
        "-S",
        ...(id.branch ? [`-r${id.branch}`] : []),
        id.repository,
      ],
      signal,
      { stdoutOnly: true, timeoutMs: 300000, maxBytes: 128 * 1024 * 1024 },
    );
    const base = rootPath(id.root);
    const serverDirectories = new Set();
    for (const line of output.stdout.toString("utf8").split(/\r?\n/)) {
      // 只有 Attic 里的文件说明该目录已被删光。
      if (!line.startsWith("/") || /\/Attic\/[^/]+,v$/.test(line.trim()))
        continue;
      const file = rlogPath(line, base, id.repository);
      if (file === undefined) continue;
      for (
        let directory = path.posix.dirname(file);
        directory !== ".";
        directory = path.posix.dirname(directory)
      )
        serverDirectories.add(directory);
    }
    const registered = new Set(
      registeredDirectories.map((directory) =>
        directory === "." ? "." : directory.slice(2),
      ),
    );
    const created = [];
    for (const directory of [...serverDirectories].sort()) {
      if (
        registered.has(directory) ||
        !registered.has(path.posix.dirname(directory))
      )
        continue;
      try {
        relativeFile(directory);
      } catch {
        continue;
      }
      const stat = await fs
        .lstat(path.join(this.root, directory))
        .catch((error) => {
          if (error.code !== "ENOENT") throw error;
        });
      // 不加 ./ 前缀（CVS 会把 ./n1 登记成 D/./n1，之后的目录登记读不了）；以 - 开头的名字会被当成选项，跳过。
      if (!stat && !directory.startsWith("-")) created.push(directory);
    }
    return created;
  }
  /** 按命令行长度分批：含可执行路径、-f、空格、引号及终止符，按 Windows 转义上界保守计长，每批不超过 8000 字符。 */
  batches(flags, items) {
    const size = (value) => 2 * value.length + 3;
    const overhead = [this.process.executable ?? "cvs", "-f", ...flags].reduce(
      (total, value) => total + size(value),
      1,
    );
    const batches = [];
    let batch = [],
      length = overhead;
    for (const item of items) {
      if (overhead + size(item) > 8000) fail("path");
      if (length + size(item) > 8000) {
        batches.push(batch);
        batch = [];
        length = overhead;
      }
      batch.push(item);
      length += size(item);
    }
    if (batch.length) batches.push(batch);
    return batches;
  }
  async commit(names, message, signal) {
    if (
      !Array.isArray(names) ||
      !names.length ||
      new Set(names).size !== names.length ||
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 16000 ||
      message.includes("\0")
    )
      fail("message");
    for (const name of names) relativeFile(name);
    // 子仓边界一次查完（同一次校验共用目录缓存），再核对清单；清单只含文件。
    const boundaries = await boundariesForPaths(this.root, "cvs", names);
    if (boundaries.length)
      throw new NestedRepositoryError(
        boundaries,
        "NESTED_REPOSITORY",
        this.root,
      );
    const files = new Set((await this.inventory()).map((file) => file.newPath));
    for (const name of names) if (!files.has(name)) fail("commitState");
    const args = names.map((name) => "./" + name);
    // 状态按批用 -n update 查询；工作副本有未解决冲突时以 1 退出，仅在输出含冲突行且未中止时接受。
    const states = new Map();
    for (const batch of this.batches(["-n", "-q", "update"], args)) {
      const output = await this.run(
        ["-n", "-q", "update", ...batch],
        signal,
        [0, 1],
      );
      const text = output.stdout.toString("utf8");
      if (output.code === 1 && (!/^C /m.test(text) || /aborted\]/.test(text)))
        fail("command");
      for (const [name, state] of parseUpdateStatus(text))
        states.set(name, state.state);
    }
    // 已登记文件在本地被删除：先 cvs remove 登记删除，再按删除提交。
    const missing = [];
    for (const name of names) {
      const state = states.get(name);
      const absent = await fs.lstat(path.join(this.root, name)).then(
        () => false,
        (error) => {
          if (error.code !== "ENOENT") throw error;
          return true;
        },
      );
      if (state === "Needs Checkout" && absent) missing.push("./" + name);
      else if (
        !["Locally Modified", "Locally Added", "Locally Removed"].includes(
          state,
        )
      )
        fail("commitState");
      await contained(this.root, name);
    }
    for (const batch of this.batches(["remove"], missing))
      await this.run(["remove", ...batch], signal);
    // 说明不计入分批长度，与单批时一致；每批是一次 cvs commit。
    for (const batch of this.batches(["commit", "-m"], args))
      await this.run(["commit", "-m", message, ...batch], signal);
  }
  /**
   * 按 8000 字符分批 cvs update -C：本地修改由 CVS 改名为同目录的 .#<文件>.<修订>，再取资源库副本。
   * 服务器已有新修订的文件同时更新到新修订（与 update -C 相同）。返回备份的相对路径。
   */
  async rollback(names, signal, progress) {
    if (
      !Array.isArray(names) ||
      !names.length ||
      new Set(names).size !== names.length
    )
      fail("path");
    for (const name of names) relativeFile(name);
    const boundaries = await boundariesForPaths(this.root, "cvs", names);
    if (boundaries.length)
      throw new NestedRepositoryError(
        boundaries,
        "NESTED_REPOSITORY",
        this.root,
      );
    // 新增、已删除登记的文件没有可恢复的修订；全部校验通过才开始写。
    const revisions = new Map(
      (await this.inventory()).map((file) => [
        file.newPath,
        file.entryRevision,
      ]),
    );
    for (const name of names) {
      if (!revisions.has(name)) fail("path");
      revision(revisions.get(name));
      await contained(this.root, name);
    }
    let done = 0;
    for (const batch of this.batches(
      ["-q", "update", "-C"],
      names.map((name) => "./" + name),
    )) {
      if (signal?.aborted) fail("cancelled");
      await this.run(["-q", "update", "-C", ...batch], signal);
      done += batch.length;
      progress?.(done, names.length);
    }
    const backups = [];
    for (const name of names) {
      const backup = path.posix.join(
        path.posix.dirname(name),
        `.#${path.posix.basename(name)}.${revisions.get(name)}`,
      );
      if (await fs.lstat(path.join(this.root, backup)).catch(() => undefined))
        backups.push(backup);
    }
    return backups;
  }
}
export async function checkout(process, root, module, target, signal) {
  cvsRoot(root);
  if (
    typeof module !== "string" ||
    !/^[\p{L}\p{N}_][\p{L}\p{N}_ ./-]*$/u.test(module) ||
    module.split("/").some((s) => !s || s === "." || s === "..") ||
    module.length > 500
  )
    fail("module");
  const parent = await fs.realpath(path.dirname(target));
  await noSymlinks(parent);
  const leaf = path.basename(target);
  relativeFile(leaf);
  if (leaf.startsWith("-")) fail("path");
  target = path.join(parent, leaf);
  await fs.mkdir(target);
  await process.run(
    ["-d", root, "checkout", "-d", leaf, module],
    parent,
    signal,
  );
  return target;
}
