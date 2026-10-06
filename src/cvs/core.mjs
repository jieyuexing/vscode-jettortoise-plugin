// biome-ignore-all lint/suspicious/noControlCharactersInRegex: CVS protocol validation must reject C0 bytes.
import { spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";
import {
  assertNoNestedRepositories,
  assertOwnedPath,
  isCvsContinuation,
  listNestedRepositories,
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
      const timer = setTimeout(() => stop("timeout"), this.timeoutMs);
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
export class CvsAdapter {
  constructor(root, process = new CvsProcess()) {
    this.root = root;
    this.process = process;
  }
  async inventory() {
    this.root = await fs.realpath(this.root);
    await noSymlinks(this.root);
    const nested = await listNestedRepositories(this.root, "cvs");
    this.lastNestedBoundaries = nested;
    const nestedRoots = new Set(nested.map((boundary) => boundary.root));
    const files = [];
    let directories = 0;
    const visit = async (directory, relative = "") => {
      if (++directories > 2000) fail("outputLimit");
      const admin = path.join(directory, "CVS");
      await noSymlinks(admin);
      for (const metadata of await fs.readdir(admin, { withFileTypes: true }))
        if (metadata.isSymbolicLink()) fail("symlink");
      for (const file of ["Root", "Repository", "Entries"])
        await noSymlinks(path.join(admin, file));
      const root = cvsRoot(
        (await fs.readFile(path.join(admin, "Root"), "utf8")).trim(),
      );
      this.repositoryRoot ??= root;
      if (root !== this.repositoryRoot) fail("root");
      const repository = (
        await fs.readFile(path.join(admin, "Repository"), "utf8")
      ).trim();
      if (
        !repository ||
        /[\x00-\x1f]/.test(repository) ||
        repository.split("/").includes("..")
      )
        fail("path");
      for (const entry of await fs.readdir(directory, {
        withFileTypes: true,
      })) {
        if (entry.isSymbolicLink()) fail("symlink");
        if (entry.isDirectory() && entry.name !== "CVS") {
          const sub = path.join(directory, entry.name);
          let realSub;
          try {
            realSub = await fs.realpath(sub);
          } catch (error) {
            if (error.code === "ENOENT") continue;
            throw error;
          }
          // A nested CVS checkout or Git repository is a separate operation
          // boundary.  It is intentionally absent from the parent inventory.
          if (nestedRoots.has(realSub)) continue;
          try {
            await fs.access(path.join(sub, "CVS"));
            if (await isCvsContinuation(directory, sub))
              await visit(sub, `${relative + entry.name}/`);
          } catch (error) {
            if (error.code !== "ENOENT") throw error;
          }
        }
      }
      try {
        await fs.access(path.join(admin, "Entries.Log"));
        fail("entriesLog");
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      for (const line of (
        await fs.readFile(path.join(admin, "Entries"), "utf8")
      ).split("\n"))
        if (line.startsWith("/")) {
          const fields = line.split("/"),
            name = relativeFile(relative + fields[1]);
          await contained(this.root, name);
          files.push({ newPath: name, entryRevision: fields[2] });
          if (files.length > 2000) fail("outputLimit");
        }
    };
    await visit(this.root);
    return files.sort((a, b) => a.newPath.localeCompare(b.newPath));
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
    const file = (await this.inventory()).find((file) => file.newPath === name);
    if (!file) fail("path");
    return file;
  }
  async run(args, signal, allowed, options) {
    return this.process.run(args, this.root, signal, allowed, options);
  }
  async status(signal) {
    const result = [];
    for (const file of await this.inventory())
      result.push({
        ...file,
        ...parseStatus(
          (
            await this.run(["status", "./" + file.newPath], signal)
          ).stdout.toString("utf8"),
        ),
      });
    return result;
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
    this.root = await fs.realpath(this.root);
    await assertNoNestedRepositories(this.root, "cvs");
    await this.inventory();
    await this.run(["update", "-dP"], signal);
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
    const files = await this.status(signal);
    for (const name of names) {
      relativeFile(name);
      await assertOwnedPath(this.root, "cvs", name);
      const file = files.find((file) => file.newPath === name);
      if (
        !file ||
        !["Locally Modified", "Locally Added", "Locally Removed"].includes(
          file.state,
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
