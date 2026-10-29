const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const exec = promisify(execFile);
const LIMIT = 10000;
let diagnostic;
function setBoundaryDiagnostic(listener) {
  diagnostic = listener;
}
function diagnose(stage, target, error) {
  if (error?.code === "BOUNDARY_UNAVAILABLE")
    diagnostic?.({ stage, path: target });
  return error;
}
function within(root, target) {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}
class NestedRepositoryError extends Error {
  constructor(boundaries = [], code = "NESTED_REPOSITORY") {
    super(
      code === "NESTED_REPOSITORY"
        ? `Nested repository boundary: ${boundaries.map((item) => item.root).join(", ")}`
        : "Repository boundary validation is incomplete",
    );
    this.code = code;
    this.boundaries = boundaries;
  }
}
async function present(file) {
  try {
    await fs.lstat(file);
    return true;
  } catch (error) {
    if (error.code === "ENOENT") return false;
    throw error;
  }
}
async function readCvsUnchecked(directory) {
  const admin = path.join(directory, "CVS");
  if (!(await present(admin))) return undefined;
  if ((await fs.lstat(admin)).isSymbolicLink())
    throw new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE");
  const values = {};
  for (const name of ["Root", "Repository"]) {
    const file = path.join(admin, name);
    const stat = await fs.lstat(file).catch(() => {
      throw new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE");
    });
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
      throw new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE");
    values[name] = await fs.readFile(file, "utf8");
  }
  values.Entries = await readCvsEntries(directory);
  values.Root = values.Root.trim();
  values.Repository = values.Repository.trim().replace(/\/$/, "");
  if (
    !values.Root ||
    !values.Repository ||
    values.Repository.split("/").includes("..")
  )
    throw new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE");
  return values;
}
async function readCvs(directory) {
  try {
    return await readCvsUnchecked(directory);
  } catch (error) {
    throw diagnose("readCvs", directory, error);
  }
}
async function readCvsEntries(directory) {
  const admin = path.join(directory, "CVS");
  const records = new Map();
  for (const name of ["Entries", "Entries.Log"]) {
    const file = path.join(admin, name);
    let stat;
    try {
      stat = await fs.lstat(file);
    } catch (error) {
      if (name === "Entries.Log" && error.code === "ENOENT") continue;
      throw new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE");
    }
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024)
      throw new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE");
    for (const line of (await fs.readFile(file, "utf8")).split(/\r?\n/)) {
      if (!line) continue;
      const logged = name === "Entries.Log";
      if (logged && !/^[AR] /.test(line))
        throw new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE");
      const record = logged ? line.slice(2) : line;
      if (record === "D") continue;
      const match = record.match(/^(D?)\/([^/]+)\//);
      if (!match) {
        if (logged) throw new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE");
        continue;
      }
      const key = `${match[1]}/${match[2]}`;
      // 日志按顺序覆盖同名记录；R 删除，后续 A 可以重新加入。
      if (logged && line.startsWith("R ")) records.delete(key);
      else records.set(key, record);
    }
  }
  return [...records.values()];
}
async function isCvsContinuation(parent, child) {
  if (path.dirname(child) !== parent) return false;
  const a = await readCvs(parent),
    b = await readCvs(child);
  if (!a || !b || a.Root !== b.Root) return false;
  const name = path.basename(child);
  return (
    b.Repository === `${a.Repository}/${name}` &&
    a.Entries.some((line) => line.startsWith(`D/${name}/`))
  );
}
// 父 Entries 未登记、但 Root 相同且 Repository 正好位于所在工作副本之下的目录，
// 属于同一项目：仍是写边界，只是不作为独立仓库列出。container 以上不再查找。
async function isCvsSameProject(directory, container) {
  if (directory === container || !within(container, directory)) return false;
  const cvs = await readCvs(directory);
  if (!cvs || (await isCvsContinuation(path.dirname(directory), directory)))
    return false;
  let owner = path.dirname(directory);
  while (!(await readCvs(owner))) {
    if (owner === container) return false;
    owner = path.dirname(owner);
  }
  while (
    owner !== container &&
    (await isCvsContinuation(path.dirname(owner), owner))
  )
    owner = path.dirname(owner);
  const parent = await readCvs(owner);
  const relative = path.relative(owner, directory).split(path.sep).join("/");
  return (
    parent.Root === cvs.Root &&
    cvs.Repository === `${parent.Repository}/${relative}`
  );
}
async function rootsAt(directory) {
  const result = [];
  if (await present(path.join(directory, ".git"))) {
    try {
      const { stdout } = await exec(
        "git",
        ["-C", directory, "rev-parse", "--show-toplevel"],
        { timeout: 10000, maxBuffer: 65536 },
      );
      const root = await fs.realpath(stdout.trim());
      if (root !== directory) throw new Error("Invalid marker");
      result.push({ kind: "git", root });
    } catch {
      throw diagnose(
        "rootsAt.git",
        directory,
        new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE"),
      );
    }
  }
  if (await readCvs(directory)) {
    if (!(await isCvsContinuation(path.dirname(directory), directory)))
      result.push({ kind: "cvs", root: directory });
  }
  return result;
}
async function existingDirectory(start) {
  let current = path.resolve(start);
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return (await fs.stat(real)).isDirectory() ? real : path.dirname(real);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}
/** Targeted ancestor inspection only; this does not register or discover children. */
async function containingRepositories(start) {
  let current = await existingDirectory(start);
  const roots = [];
  for (;;) {
    roots.push(...(await rootsAt(current)));
    const parent = path.dirname(current);
    if (parent === current) return roots;
    current = parent;
  }
}
async function nearestRepositories(start) {
  let current = await existingDirectory(start);
  for (;;) {
    const roots = await rootsAt(current);
    if (roots.length) return roots;
    const parent = path.dirname(current);
    if (parent === current) return [];
    current = parent;
  }
}
async function boundariesForPaths(root, _kind, paths) {
  root = await fs.realpath(root);
  const found = new Map();
  // Cache only within this validation, never across queued operations.
  const inspected = new Map();
  async function inspect(directory) {
    if (!inspected.has(directory)) inspected.set(directory, rootsAt(directory));
    return inspected.get(directory);
  }
  async function inspectAncestors(directory) {
    while (directory !== root) {
      const boundaries = await inspect(directory);
      if (boundaries.length) {
        for (const boundary of boundaries)
          found.set(`${boundary.kind}\0${boundary.root}`, boundary);
        break;
      }
      directory = path.dirname(directory);
    }
  }
  for (const relative of paths) {
    if (
      typeof relative !== "string" ||
      !relative ||
      relative.includes("\0") ||
      path.isAbsolute(relative) ||
      /^[A-Za-z]:/.test(relative) ||
      relative.replace(/\\/g, "/").split("/").includes("..")
    )
      throw new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE");
    const target = path.resolve(root, relative);
    if (!within(root, target))
      throw new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE");
    const directory = await existingDirectory(target);
    if (!within(root, directory))
      throw new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE");
    await inspectAncestors(directory);
    // Deleting/renaming a symlink changes its lexical parent, even when its
    // canonical target points back into the owning repository.
    let lexical = path.dirname(target);
    while (lexical !== root) {
      try {
        const real = await fs.realpath(lexical);
        if (!within(root, real))
          throw new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE");
        await inspectAncestors(real);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      lexical = path.dirname(lexical);
    }
  }
  return [...found.values()];
}
async function assertOwnedPath(root, kind, relative) {
  const boundaries = await boundariesForPaths(root, kind, [relative]);
  if (boundaries.length) throw new NestedRepositoryError(boundaries);
  // A directory-targeted mutation may replace a whole subtree. Inspect that
  // subtree before accepting it, including unregistered/ignored child roots.
  const target = path.resolve(await fs.realpath(root), relative);
  const stat = await fs.lstat(target).catch((error) => {
    if (error.code !== "ENOENT") throw error;
  });
  if (stat?.isDirectory()) {
    const nested = await walkNested(target, root);
    if (nested.length) throw new NestedRepositoryError(nested);
  }
}
// 每次验证独立缓存；父子连续性复用同一份元数据，不跨操作复用。
async function repositoryTree(start, ownerRoot = start, options = {}) {
  const nested = [],
    directories = [],
    pending = [start];
  const metadata = new Map();
  const read = (directory) => {
    if (!metadata.has(directory)) metadata.set(directory, readCvs(directory));
    return metadata.get(directory);
  };
  let visited = 0;
  try {
    while (pending.length) {
      const batch = pending.splice(0, 8);
      const results = await Promise.all(
        batch.map(async (directory) => {
          if (++visited > LIMIT)
            throw new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE");
          const cvs = await read(directory);
          const roots = [];
          if (directory !== ownerRoot) {
            if (await present(path.join(directory, ".git"))) {
              const git = (await rootsAt(directory)).filter(
                (root) => root.kind === "git",
              );
              roots.push(...git);
            }
            if (cvs) {
              const parent = await read(path.dirname(directory));
              if (
                !parent ||
                parent.Root !== cvs.Root ||
                cvs.Repository !==
                  `${parent.Repository}/${path.basename(directory)}` ||
                !parent.Entries.some((line) =>
                  line.startsWith(`D/${path.basename(directory)}/`),
                )
              )
                roots.push({ kind: "cvs", root: directory });
            }
          }
          if (roots.length) return { roots };
          // 仅清单读取可在未管理目录处停止；全树写预检保持完整遍历。
          if (options.managedOnly && directory !== ownerRoot && !cvs)
            return { directory, entries: [], cvs, unmanaged: true };
          const entries = await fs.readdir(directory, { withFileTypes: true });
          return { directory, entries, cvs };
        }),
      );
      for (const item of results) {
        if (item.roots) {
          nested.push(...item.roots);
          continue;
        }
        directories.push(item);
        for (const entry of item.entries)
          if (
            entry.isDirectory() &&
            entry.name !== ".git" &&
            entry.name !== "CVS"
          )
            pending.push(path.join(item.directory, entry.name));
      }
    }
  } catch (error) {
    throw diagnose(
      "repositoryTree",
      start,
      error instanceof NestedRepositoryError
        ? error
        : new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE"),
    );
  }
  return { nested, directories };
}
async function walkNested(start, ownerRoot) {
  return (await repositoryTree(start, ownerRoot)).nested;
}
/** Only used to preflight an explicit whole-worktree operation, never startup. */
async function listNestedRepositories(root, _kind) {
  const real = await fs.realpath(root);
  return walkNested(real, real);
}
async function assertNoNestedRepositories(root, kind) {
  const boundaries = await listNestedRepositories(root, kind);
  if (boundaries.length) throw new NestedRepositoryError(boundaries);
}

function traced(stage, action) {
  return async (...args) => {
    try {
      return await action(...args);
    } catch (error) {
      throw diagnose(stage, String(args[0]), error);
    }
  };
}
exports.within = within;
exports.NestedRepositoryError = NestedRepositoryError;
exports.containingRepositories = traced(
  "containingRepositories",
  containingRepositories,
);
exports.nearestRepositories = traced(
  "nearestRepositories",
  nearestRepositories,
);
exports.isCvsContinuation = traced("isCvsContinuation", isCvsContinuation);
exports.isCvsSameProject = traced("isCvsSameProject", isCvsSameProject);
exports.readCvsEntries = traced("readCvsEntries", readCvsEntries);
exports.boundariesForPaths = traced("boundariesForPaths", boundariesForPaths);
exports.assertOwnedPath = traced("assertOwnedPath", assertOwnedPath);
exports.listNestedRepositories = traced(
  "listNestedRepositories",
  listNestedRepositories,
);
exports.assertNoNestedRepositories = traced(
  "assertNoNestedRepositories",
  assertNoNestedRepositories,
);

exports.repositoryTree = traced("repositoryTree", repositoryTree);
exports.setBoundaryDiagnostic = setBoundaryDiagnostic;
