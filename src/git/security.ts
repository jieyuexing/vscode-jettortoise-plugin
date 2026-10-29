import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assertOwnedPath } from "../repositories/boundaries.cjs";

/**
 * A repository-relative path suitable for passing to Git after `--`.
 *
 * Git paths are deliberately allowed to contain whitespace and Unicode, but
 * never an absolute path, traversal component, or a platform-specific drive
 * / UNC prefix.
 */
export function safeRelativePath(value: string): string {
  if (typeof value !== "string" || value.length === 0 || value.includes("\0")) {
    throw new Error("A non-empty repository-relative path is required");
  }
  if (
    path.isAbsolute(value) ||
    /^[A-Za-z]:[\\/]/.test(value) ||
    /^\\\\/.test(value)
  ) {
    throw new Error("Absolute paths are not allowed");
  }

  const segments = value.replace(/\\/g, "/").split("/");
  if (
    segments.some(
      (segment) => segment.length === 0 || segment === "." || segment === "..",
    )
  ) {
    throw new Error("Path traversal is not allowed");
  }
  if (segments.some((segment) => segment.toLowerCase() === ".git")) {
    throw new Error("Git metadata paths are not allowed");
  }
  return segments.join(path.sep);
}

async function realExistingAncestor(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    try {
      return await fs.realpath(current);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
      // A dangling symlink is not a missing ordinary file: writing through it
      // could create a target outside the repository.
      const entry = await fs.lstat(current).catch((statError) => {
        if ((statError as NodeJS.ErrnoException).code !== "ENOENT") {
          throw statError;
        }
        return undefined;
      });
      if (entry?.isSymbolicLink()) {
        throw new Error("Dangling symbolic links are not allowed");
      }
      const parent = path.dirname(current);
      if (parent === current) throw error;
      current = parent;
    }
  }
}

async function assertNotSymlink(
  candidate: string,
  label: string,
): Promise<void> {
  const stat = await fs.lstat(candidate);
  if (stat.isSymbolicLink()) {
    throw new Error(`${label} cannot be a symbolic link`);
  }
}

function isWithin(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      !relative.startsWith(`..${path.sep}`) &&
      relative !== "..")
  );
}

/** Resolve a path only if its lexical and resolved/symlink paths stay in root. */
export async function resolveWorktreePath(
  root: string,
  relativePath: string,
  options: { allowMissing?: boolean } = {},
): Promise<string> {
  const safePath = safeRelativePath(relativePath);
  const realRoot = await fs.realpath(root);
  const candidate = path.resolve(realRoot, safePath);
  if (!isWithin(realRoot, candidate)) {
    throw new Error("Path is outside the repository");
  }

  try {
    const realCandidate = await fs.realpath(candidate);
    if (!isWithin(realRoot, realCandidate)) {
      throw new Error("Path resolves outside the repository");
    }
    // Validate the canonical target too, including aliases into Git metadata.
    safeRelativePath(path.relative(realRoot, realCandidate));
    // Keep unlink/rename semantics on an in-repository symlink itself.
    return candidate;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    if (!options.allowMissing) throw error;
    const realParent = await realExistingAncestor(candidate);
    if (!isWithin(realRoot, realParent)) {
      throw new Error("Path parent resolves outside the repository");
    }
    const parentRelative = path.relative(realRoot, realParent);
    if (parentRelative) safeRelativePath(parentRelative);
    return candidate;
  }
}

function safeShelfName(name: string): string {
  const safe = safeRelativePath(name);
  if (safe.includes(path.sep)) {
    throw new Error("Shelf names cannot contain path separators");
  }
  return safe;
}

export interface ShelfEntryPaths {
  directory: string;
  patch: string;
  xml: string;
}

/**
 * Resolve a persisted IDEA shelf entry. The XML and patch must be the normal
 * files under `.idea/shelf/<name>`; a symlink or XML-supplied external path is
 * rejected before callers can read, apply, export, or delete it.
 */
export async function resolveShelfEntry(
  root: string,
  name: string,
): Promise<ShelfEntryPaths> {
  const shelfName = safeShelfName(name);
  await assertOwnedPath(root, "git", path.join(".idea", "shelf", shelfName));
  const shelfRoot = await resolveWorktreePath(root, ".idea/shelf");
  const directoryCandidate = path.join(shelfRoot, shelfName);
  const patchCandidate = path.join(directoryCandidate, "shelved.patch");
  const xmlCandidate = path.join(shelfRoot, `${shelfName}.xml`);
  await Promise.all([
    assertNotSymlink(directoryCandidate, "Shelf directory"),
    assertNotSymlink(patchCandidate, "Shelf patch"),
    assertNotSymlink(xmlCandidate, "Shelf metadata"),
  ]);
  const directory = await resolveWorktreePath(shelfRoot, shelfName);
  const patch = await resolveWorktreePath(directory, "shelved.patch");
  const xml = await resolveWorktreePath(shelfRoot, `${shelfName}.xml`);
  return { directory, patch, xml };
}

/** Git ref names accepted by branch/ref commands, excluding command options. */
export function safeGitRef(value: string, label = "Git ref"): string {
  if (typeof value !== "string" || value.length === 0 || value.length > 255) {
    throw new Error(`${label} is invalid`);
  }
  if (
    value.startsWith("-") ||
    value.includes("\0") ||
    value.includes("@{") ||
    value.includes("..") ||
    value.includes("//") ||
    value.endsWith("/") ||
    value.endsWith(".") ||
    /[\s~^:?*\\[\\\\]/.test(value) ||
    value
      .split("/")
      .some(
        (part) =>
          part.length === 0 ||
          part === "." ||
          part === ".." ||
          part.endsWith(".lock"),
      )
  ) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}

/** A ref or one ordinary parent/ancestor suffix used by history operations. */
export function safeGitRevision(value: string, label = "Git revision"): string {
  const match = /^(.*?)(?:([~^])(\d*))?$/.exec(value);
  if (!match || !match[1]) {
    throw new Error(`${label} is invalid`);
  }
  safeGitRef(match[1], label);
  return value;
}

/** Git content accepts only ordinary revisions or the four Git index stages. */
export function safeGitContentRef(value: string): string {
  if (/^:[0-3]$/.test(value)) return value;
  return safeGitRevision(value, "Git content revision");
}

export function safeRemoteName(value: string): string {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
    throw new Error("Remote name is invalid");
  }
  return value;
}

export function safeObjectId(value: string, label = "Object id"): string {
  if (!/^[0-9a-fA-F]{4,64}$/.test(value)) {
    throw new Error(`${label} is invalid`);
  }
  return value;
}
