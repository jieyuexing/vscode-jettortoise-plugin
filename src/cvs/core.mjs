// biome-ignore-all lint/suspicious/noControlCharactersInRegex: CVS protocol validation must reject C0 bytes.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  assertOwnedPath,
  isCvsContinuation,
  readCvsEntries,
  registeredCvsDirectories,
  repositoryTree,
} from "../repositories/boundaries.cjs";

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
    /^:pserver:(?:[\w.-]+@)?[\w.-]+(?::\d{1,5})?:\/[^\s]+$/.test(value)
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
      if (allowMissing && error.code === "ENOENT" && current === absolute)
        return absolute;
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
    if (signal?.aborted) return Promise.reject(new CvsError("cancelled"));
    return new Promise((resolve, reject) => {
      const env = { ...process.env, LC_ALL: "C", LANG: "C" };
      for (const key of Object.keys(env))
        if (/^(CVS|RCS)/.test(key)) delete env[key];
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
export function parseLog(text) {
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
      name: match[1],
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
      const message = match[5]
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
          author: { name: match[3] },
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
      unknown = [];
    for (const { directory, entries, cvs } of tree.directories) {
      if (!cvs) {
        const relative = path
          .relative(this.root, directory)
          .split(path.sep)
          .join("/");
        if (relative) unknown.push(relativeFile(relative) + "/");
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
      for (const entry of entries) {
        if (entry.isSymbolicLink()) fail("symlink");
        if (entry.isFile() && !names.has(entry.name))
          unknown.push(relativeFile(prefix + entry.name));
      }
    }
    files.sort((a, b) => a.newPath.localeCompare(b.newPath));
    return { files, unknown };
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
      const result = [];
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
          if (stat?.isFile())
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
    const result = [];
    for (let start = 0; start < files.length; start += 32)
      result.push(
        ...(await Promise.all(
          files
            .slice(start, start + 32)
            .map(async (file) => this.withRemote(await this.localFile(file))),
        )),
      );
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
    else if (timestamp?.includes("+")) state = "File had conflicts on merge";
    else {
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
    const output = await this.run(["-n", "-q", "update"], signal, [0], {
      timeoutMs: 180000,
    });
    const states = parseUpdateStatus(output.stdout.toString("utf8"));
    const result = files
      .filter((file) => file.state !== "Unknown")
      .map((file) => ({
        ...file,
        ...(states.get(file.newPath)?.state === "Needs Merge" &&
        file.state === "File had conflicts on merge"
          ? parseStatus("Status: File had conflicts on merge")
          : (states.get(file.newPath) ?? parseStatus("Status: Up-to-date"))),
      }));
    const known = new Set(result.map((file) => file.newPath));
    for (const [name, state] of states) {
      if (known.has(name) || state.state !== "Unknown") continue;
      try {
        relativeFile(name);
        await contained(this.root, name);
        await assertOwnedPath(this.root, "cvs", name);
        const stat = await fs.lstat(path.join(this.root, name));
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
  async log(name, signal) {
    await this.file(name);
    return parseLog(
      (await this.run(["log", "./" + name], signal)).stdout.toString("utf8"),
    );
  }
  async content(name, rev, signal, options = {}) {
    revision(rev);
    if (!(await this.log(name, signal)).some((item) => item.revisionId === rev))
      fail("revision");
    return (
      await this.run(["update", "-p", "-r", rev, "./" + name], signal, [0], {
        stdoutOnly: true,
        maxBytes: options.maxBytes,
      })
    ).stdout;
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
    // 含可执行路径、-f、空格、引号及终止符；按 Windows 转义上界保守计长。
    const size = (value) => 2 * value.length + 3;
    const overhead = [this.process.executable ?? "cvs", "-f", ...flags].reduce(
      (total, value) => total + size(value),
      1,
    );
    const batches = [];
    let batch = [],
      length = overhead;
    for (const directory of directories) {
      if (overhead + size(directory) > 8000) fail("path");
      if (length + size(directory) > 8000) {
        batches.push(batch);
        batch = [];
        length = overhead;
      }
      batch.push(directory);
      length += size(directory);
    }
    if (batch.length) batches.push(batch);
    for (const args of batches) {
      if (signal?.aborted) fail("cancelled");
      await this.run([...flags, ...args], signal);
    }
  }
  async commit(names, message, signal) {
    if (
      !Array.isArray(names) ||
      !names.length ||
      names.length > 2000 ||
      new Set(names).size !== names.length ||
      typeof message !== "string" ||
      !message.trim() ||
      message.length > 16000 ||
      message.includes("\0")
    )
      fail("message");
    const files = await this.inventory();
    for (const name of names) {
      relativeFile(name);
      await assertOwnedPath(this.root, "cvs", name);
      const file = files.find((file) => file.newPath === name);
      if (!file) fail("commitState");
      const { state } = parseStatus(
        (await this.run(["status", "./" + name], signal)).stdout.toString(
          "utf8",
        ),
      );
      if (
        !["Locally Modified", "Locally Added", "Locally Removed"].includes(
          state,
        )
      )
        fail("commitState");
      await contained(this.root, name);
    }
    await this.run(
      ["commit", "-m", message, ...names.map((name) => "./" + name)],
      signal,
    );
  }
  async rollback(name, signal) {
    relativeFile(name);
    await contained(this.root, name);
    await assertOwnedPath(this.root, "cvs", name);
    const file = await this.file(name);
    revision(file.entryRevision);
    const target = await contained(this.root, name, false),
      before = await fs.stat(target),
      original = await fs.readFile(target),
      content = await this.content(name, file.entryRevision, signal);
    if (signal?.aborted) fail("cancelled");
    await assertOwnedPath(this.root, "cvs", name);
    const backup = target + ".jettortoise-backup-" + randomUUID(),
      temp = target + ".jettortoise-restore-" + randomUUID();
    await fs.writeFile(backup, original, {
      flag: "wx",
      mode: before.mode & 0o777,
    });
    try {
      await fs.writeFile(temp, content, {
        flag: "wx",
        mode: before.mode & 0o777,
      });
      await contained(this.root, name, false);
      await assertOwnedPath(this.root, "cvs", name);
      const now = await fs.stat(target);
      if (
        now.ino !== before.ino ||
        now.mtimeMs !== before.mtimeMs ||
        !original.equals(await fs.readFile(target))
      )
        fail("changed");
      if (signal?.aborted) fail("cancelled");
      await fs.rename(temp, target);
    } finally {
      await fs.rm(temp, { force: true });
    }
    return path.basename(backup);
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
