const { execFile } = require("node:child_process");
const fs = require("node:fs/promises");
const path = require("node:path");
const { promisify } = require("node:util");

const exec = promisify(execFile);
const LIMIT = 10000;
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
async function readCvs(directory) {
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
      throw new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE");
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
async function walkNested(start, ownerRoot) {
  const result = [];
  let visited = 0;
  async function visit(directory) {
    if (++visited > LIMIT)
      throw new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE");
    if (directory !== ownerRoot) {
      const roots = await rootsAt(directory);
      if (roots.length) {
        result.push(...roots);
        return;
      }
    }
    const entries = await fs.readdir(directory, { withFileTypes: true });
    for (const entry of entries) {
      // Never follow symlinks or read VCS administration internals as a tree.
      if (entry.isDirectory() && entry.name !== ".git" && entry.name !== "CVS")
        await visit(path.join(directory, entry.name));
    }
  }
  try {
    await visit(start);
  } catch (error) {
    if (error instanceof NestedRepositoryError) throw error;
    throw new NestedRepositoryError([], "BOUNDARY_UNAVAILABLE");
  }
  return result;
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

exports.within = within;
exports.NestedRepositoryError = NestedRepositoryError;
exports.containingRepositories = containingRepositories;
exports.nearestRepositories = nearestRepositories;
exports.isCvsContinuation = isCvsContinuation;
exports.readCvsEntries = readCvsEntries;
exports.boundariesForPaths = boundariesForPaths;
exports.assertOwnedPath = assertOwnedPath;
exports.listNestedRepositories = listNestedRepositories;
exports.assertNoNestedRepositories = assertNoNestedRepositories;
