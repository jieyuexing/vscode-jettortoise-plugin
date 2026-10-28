import * as fs from "node:fs/promises";
import * as path from "node:path";
import { isCvsContinuation } from "./boundaries.cjs";
import type { RepositoryKind } from "./types";

export interface DiscoveredRoot {
  kind: RepositoryKind;
  root: string;
  /** Local metadata only: branch, detached short ref, or CVS sticky tag. */
  ref?: string;
}
export interface DiscoveryProgress {
  roots: readonly DiscoveredRoot[];
  incomplete: boolean;
  cancelled: boolean;
  errors: readonly string[];
}
export interface DiscoveryOptions {
  signal?: AbortSignal;
  concurrency?: number;
  onProgress?: (progress: DiscoveryProgress) => void;
}
function isAbsent(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    ["ENOENT", "ENOTDIR"].includes(
      String((error as NodeJS.ErrnoException).code),
    )
  );
}

async function gitDirectory(directory: string): Promise<string | undefined> {
  const marker = path.join(directory, ".git");
  try {
    const stat = await fs.lstat(marker);
    if (stat.isDirectory()) {
      if (stat.isSymbolicLink()) return;
      return (await validGitDirectory(marker)) ? marker : undefined;
    }
    if (!stat.isFile() || stat.size > 64 * 1024) return;
    // A worktree uses a gitdir pointer. Validate only its local shape: this is
    // discovery, so do not invoke Git or cause any remote/config side effect.
    const line = (await fs.readFile(marker, "utf8")).trim();
    if (!line.startsWith("gitdir:")) return;
    const target = line.slice("gitdir:".length).trim();
    if (!target || target.includes("\0")) return;
    const resolved = path.resolve(directory, target);
    return (await validGitDirectory(resolved)) ? resolved : undefined;
  } catch (error) {
    if (isAbsent(error)) return;
    throw error;
  }
}
async function gitRef(directory: string): Promise<string | undefined> {
  try {
    const head = (
      await fs.readFile(path.join(directory, "HEAD"), "utf8")
    ).trim();
    const branch = /^ref:\s*refs\/heads\/(.+)$/.exec(head)?.[1];
    return (
      branch || (/^[a-f0-9]{7,64}$/i.test(head) ? head.slice(0, 12) : undefined)
    );
  } catch (error) {
    if (isAbsent(error)) return;
    throw error;
  }
}
async function validGitDirectory(directory: string): Promise<boolean> {
  try {
    const [stat, head, objects] = await Promise.all([
      fs.lstat(directory),
      fs.lstat(path.join(directory, "HEAD")),
      fs.lstat(path.join(directory, "objects")).catch((error) => {
        if (isAbsent(error)) return undefined;
        throw error;
      }),
    ]);
    if (!stat.isDirectory() || stat.isSymbolicLink() || !head.isFile())
      return false;
    // Linked worktree admin directories have HEAD plus a `commondir` pointer;
    // normal repositories keep objects directly in this directory.
    if (objects?.isDirectory()) return true;
    const common = await fs.readFile(path.join(directory, "commondir"), "utf8");
    const commonDirectory = path.resolve(directory, common.trim());
    return (await fs.stat(path.join(commonDirectory, "objects"))).isDirectory();
  } catch (error) {
    if (isAbsent(error)) return false;
    throw error;
  }
}

interface CvsMeta {
  root: string;
  repository: string;
  tag?: string;
}
async function cvsMeta(directory: string): Promise<CvsMeta | undefined> {
  const admin = path.join(directory, "CVS");
  try {
    const stat = await fs.lstat(admin);
    if (!stat.isDirectory() || stat.isSymbolicLink()) return;
    const read = async (name: string) => {
      const file = path.join(admin, name);
      const fileStat = await fs.lstat(file);
      if (!fileStat.isFile() || fileStat.size > 4 * 1024 * 1024)
        throw new Error("invalid CVS metadata");
      return fs.readFile(file, "utf8");
    };
    const [root, repository] = await Promise.all([
      read("Root"),
      read("Repository"),
      read("Entries"),
    ]);
    const normalizedRoot = root.trim();
    const normalizedRepository = repository.trim().replace(/\/$/, "");
    if (
      !normalizedRoot ||
      !normalizedRepository ||
      normalizedRepository.split("/").includes("..")
    )
      return;
    const tag = await fs
      .readFile(path.join(admin, "Tag"), "utf8")
      .catch((error) => {
        if (isAbsent(error)) return "";
        throw error;
      });
    return {
      root: normalizedRoot,
      repository: normalizedRepository,
      tag: tag.trim() || undefined,
    };
  } catch (error) {
    if (isAbsent(error)) return;
    throw error;
  }
}
/** Read a current display reference from local VCS metadata only. */
export async function readRepositoryReference(
  kind: RepositoryKind,
  root: string,
): Promise<string | undefined> {
  if (kind === "git") {
    const directory = await gitDirectory(root);
    return directory ? gitRef(directory) : undefined;
  }
  return (await cvsMeta(root))?.tag;
}

/**
 * Recursively reads local VCS markers below workspaceRoot. It deliberately
 * keeps walking through recognised repositories; registration and operations
 * happen elsewhere. Symlink directories and administration trees are skipped.
 */
export async function discoverRepositoryRoots(
  workspaceRoot: string,
  options: DiscoveryOptions = {},
): Promise<DiscoveryProgress> {
  const root = await fs.realpath(workspaceRoot);
  const roots = new Map<string, DiscoveredRoot>();
  const errors: string[] = [];
  let incomplete = false;
  let cancelled = false;
  const queue = [root];
  const concurrency = Math.max(1, Math.min(16, options.concurrency ?? 8));
  let lastEmission = 0,
    lastRootCount = -1,
    lastErrors = -1;
  const emit = (force = false) => {
    if (
      !force &&
      roots.size === lastRootCount &&
      errors.length === lastErrors &&
      Date.now() - lastEmission < 250
    )
      return;
    lastEmission = Date.now();
    lastRootCount = roots.size;
    lastErrors = errors.length;
    options.onProgress?.({
      roots: [...roots.values()],
      incomplete,
      cancelled,
      errors,
    });
  };
  const visit = async (directory: string) => {
    if (options.signal?.aborted) {
      cancelled = true;
      incomplete = true;
      return;
    }
    try {
      // Recheck the lexical node immediately before any directory traversal.
      // A path switched to a symlink during scan is skipped rather than being
      // followed outside the current workspace root.
      const directoryStat = await fs.lstat(directory);
      if (!directoryStat.isDirectory() || directoryStat.isSymbolicLink())
        return;
      if ((await fs.realpath(directory)) !== directory) return;
      const git = await gitDirectory(directory);
      if (git)
        roots.set(`git\0${directory}`, {
          kind: "git",
          root: directory,
          ref: await gitRef(git),
        });
      const cvs = await cvsMeta(directory);
      if (cvs && !(await isCvsContinuation(path.dirname(directory), directory)))
        roots.set(`cvs\0${directory}`, {
          kind: "cvs",
          root: directory,
          ref: cvs.tag,
        });
      const entries = await fs.readdir(directory, { withFileTypes: true });
      for (const entry of entries) {
        if (
          !entry.isDirectory() ||
          entry.isSymbolicLink() ||
          entry.name === ".git" ||
          entry.name === "CVS"
        )
          continue;
        queue.push(path.join(directory, entry.name));
      }
    } catch (error) {
      incomplete = true;
      const message =
        error instanceof Error ? error.message : "Unable to read directory";
      if (errors.length < 50) errors.push(`${directory}: ${message}`);
    }
    emit();
  };
  // Process breadth-first batches. This keeps the frontier finite, reports
  // incremental roots, and gives every filesystem operation a bounded pool.
  while (queue.length && !options.signal?.aborted) {
    const batch = queue.splice(0, concurrency);
    await Promise.all(batch.map(visit));
  }
  if (options.signal?.aborted) {
    cancelled = true;
    incomplete = true;
  }
  emit(true);
  return { roots: [...roots.values()], incomplete, cancelled, errors };
}
