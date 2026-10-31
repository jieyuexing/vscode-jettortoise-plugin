import * as fs from "node:fs/promises";
import * as path from "node:path";
import { TextDecoder } from "node:util";
import * as vscode from "vscode";
import { GitContentTooLargeError, type GitService } from "../git/gitService";
import { resolveWorktreePath, safeRelativePath } from "../git/security";
import type { DiffFile } from "../git/types";
import { assertOwnedPath } from "../repositories/boundaries.cjs";

/** The small adapter surface shared with the native CVS core. */
export interface CvsComparisonAdapter {
  file(name: string): Promise<{ entryRevision: string }>;
  content(
    name: string,
    revision: string,
    signal?: AbortSignal,
    options?: { maxBytes?: number },
  ): Promise<Buffer>;
}

/** Limits deliberately apply independently to both visible sides. */
export const COMPARISON_MAX_BYTES = 2 * 1024 * 1024;
export const COMPARISON_MAX_LINES = 20_000;

export type {
  ComparisonMaterialization,
  ComparisonSide,
  ComparisonSource,
  MaterializedComparison,
  ResolvedComparison,
} from "./types";

import type {
  ComparisonMaterialization,
  ComparisonSide,
  MaterializedComparison,
  ResolvedComparison,
} from "./types";

function shortRef(ref: string): string {
  return ref.length > 7 ? ref.slice(0, 7) : ref;
}

function filename(value: string): string {
  return value.split("/").pop() || value;
}

function gitSide(
  path: string,
  revision: string,
  label: ComparisonSide["label"],
): ComparisonSide {
  return { source: "git", path: safeRelativePath(path), revision, label };
}

function emptySide(path: string): ComparisonSide {
  return { source: "empty", path: safeRelativePath(path), label: "empty" };
}

async function checkedGitWorktreeSide(
  root: string,
  filePath: string,
): Promise<ComparisonSide> {
  const safePath = safeRelativePath(filePath);
  await resolveWorktreePath(root, safePath, { allowMissing: true });
  await assertOwnedPath(root, "git", safePath);
  return { source: "worktree", path: safePath, label: "worktree" };
}

async function checkedCvsWorktreeSide(
  root: string,
  filePath: string,
): Promise<ComparisonSide> {
  const safePath = safeCvsRelativeFile(filePath);
  await assertOwnedPath(root, "cvs", safePath);
  const realRoot = await fs.realpath(root);
  const target = path.resolve(realRoot, safePath);
  if (!target.startsWith(`${realRoot}${path.sep}`)) {
    throw new Error(vscode.l10n.t("Path is outside the repository"));
  }
  return { source: "worktree", path: safePath, label: "worktree" };
}

function safeCvsRelativeFile(value: string): string {
  if (
    typeof value !== "string" ||
    !value ||
    value.length > 2048 ||
    hasCvsControlOrBackslash(value) ||
    path.isAbsolute(value) ||
    value
      .split("/")
      .some(
        (segment) =>
          !segment ||
          segment === "." ||
          segment === ".." ||
          segment.toLowerCase() === "cvs",
      )
  ) {
    throw new Error(
      vscode.l10n.t("A repository-relative CVS path is required"),
    );
  }
  return value;
}

function hasCvsControlOrBackslash(value: string): boolean {
  for (const character of value) {
    const code = character.charCodeAt(0);
    if (character === "\\" || code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * Resolve a Git diff into stable side specifications.  This does not read disk
 * for historical objects, so a later nested repository cannot hide a parent
 * commit object.  Worktree reads are ownership checked separately.
 */
export class GitComparisonResolver {
  constructor(
    private readonly git: GitService,
    private readonly root: string,
  ) {}

  async working(
    filePath: string,
    staged: boolean,
    fileMeta?: DiffFile,
  ): Promise<ResolvedComparison> {
    const discovered =
      fileMeta ?? (await this.workingMetadata(filePath, staged));
    const worktree = await checkedGitWorktreeSide(this.root, filePath);
    const safePath = worktree.path;
    const oldPath = safeRelativePath(discovered?.oldPath || safePath);
    const newPath = safeRelativePath(discovered?.newPath || safePath);
    const status = discovered?.status ?? "modified";
    const file = filename(newPath || oldPath);
    if (staged) {
      const left =
        status === "added"
          ? emptySide(newPath)
          : gitSide(oldPath, "HEAD", "head");
      const right =
        status === "deleted"
          ? emptySide(oldPath)
          : gitSide(newPath, ":0", "index");
      return {
        kind: "git",
        source: "working",
        filePath: newPath || oldPath,
        title: vscode.l10n.t("{0} (HEAD ↔ Staged)", file),
        left,
        right,
      };
    }
    const left =
      status === "added" ? emptySide(newPath) : gitSide(oldPath, ":0", "index");
    const right =
      status === "deleted"
        ? emptySide(oldPath)
        : { ...worktree, path: newPath };
    return {
      kind: "git",
      source: "working",
      filePath: newPath || oldPath,
      title: vscode.l10n.t("{0} (Staged ↔ Working Tree)", file),
      left,
      right,
    };
  }

  private async workingMetadata(
    filePath: string,
    staged: boolean,
  ): Promise<DiffFile> {
    const safePath = safeRelativePath(filePath);
    const change = (await this.git.getWorkingTreeChanges()).find(
      (item) => item.path === safePath && item.staged === staged,
    );
    // The comparison channel is a management surface, not a general-purpose
    // repository file reader.  A forged request must name an actual current
    // change for this fixed repository and side.
    if (!change)
      throw new Error(
        vscode.l10n.t(
          "The requested working-tree change is no longer available",
        ),
      );
    return {
      oldPath: change.oldPath || change.path,
      newPath: change.path,
      status:
        change.status === "untracked"
          ? "added"
          : change.status === "conflicted"
            ? "modified"
            : change.status,
      isBinary: false,
    };
  }

  async history(
    commit: string,
    filePath: string,
    fileMeta?: DiffFile,
    baseRef?: string,
    cherryPickHashes?: string[],
  ): Promise<ResolvedComparison> {
    const status = fileMeta?.status ?? "modified";
    const oldPath = safeRelativePath(fileMeta?.oldPath || filePath);
    const newPath = safeRelativePath(fileMeta?.newPath || filePath);
    let rightRef = commit;
    let leftRef = "";
    if (cherryPickHashes && cherryPickHashes.length > 1) {
      const range = await this.git.findFileRange(
        cherryPickHashes,
        newPath || oldPath,
      );
      if (range) {
        rightRef = range.newest;
        leftRef = (await this.git.getCommitParents(range.oldest))[0] ?? "";
      }
    }
    if (!leftRef) {
      leftRef = baseRef ?? (await this.git.getCommitParents(commit))[0] ?? "";
    }

    let left: ComparisonSide;
    let right: ComparisonSide;
    switch (status) {
      case "added":
        left = emptySide(newPath);
        right = gitSide(newPath, rightRef, "revision");
        break;
      case "deleted":
        left = leftRef
          ? gitSide(oldPath, leftRef, "revision")
          : emptySide(oldPath);
        right = emptySide(oldPath);
        break;
      case "renamed":
      case "copied":
        left = leftRef
          ? gitSide(oldPath, leftRef, "revision")
          : emptySide(oldPath);
        right = gitSide(newPath, rightRef, "revision");
        break;
      default:
        left = leftRef
          ? gitSide(newPath, leftRef, "revision")
          : emptySide(newPath);
        right = gitSide(newPath, rightRef, "revision");
    }
    const display = filename(filePath);
    const title =
      cherryPickHashes && cherryPickHashes.length > 1
        ? vscode.l10n.t("{0} ({1} commits)", display, cherryPickHashes.length)
        : baseRef
          ? vscode.l10n.t(
              "{0} ({1}..{2})",
              display,
              shortRef(baseRef),
              shortRef(commit),
            )
          : vscode.l10n.t("{0} ({1})", display, shortRef(commit));
    return {
      kind: "git",
      source: "history",
      filePath: newPath || oldPath,
      title,
      left,
      right,
    };
  }

  async materialize(
    comparison: ResolvedComparison,
  ): Promise<MaterializedComparison> {
    return materialize(comparison, async (side) => {
      if (side.source === "empty") return Buffer.alloc(0);
      if (side.source === "git")
        return this.git.getFileContentBufferLimited(
          side.revision ?? "",
          side.path,
          COMPARISON_MAX_BYTES,
        );
      await checkedGitWorktreeSide(this.root, side.path);
      return readLimitedFile(
        await resolveWorktreePath(this.root, side.path, {
          allowMissing: false,
        }),
      );
    });
  }
}

/** CVS counterpart.  It intentionally exposes only CVS revisions and disk. */
export class CvsComparisonResolver {
  constructor(
    private readonly cvs: CvsComparisonAdapter,
    private readonly root: string,
  ) {}

  async working(
    filePath: string,
    selectedRevision?: string,
    metadata?: { entryRevision: string },
  ): Promise<ResolvedComparison> {
    const checkedRight = await checkedCvsWorktreeSide(this.root, filePath);
    const file = metadata ?? (await this.cvs.file(checkedRight.path));
    const revision = (selectedRevision ?? file.entryRevision).replace(/^-/, "");
    // CVS writes revision `0` into Entries after `cvs add`; it has no base
    // content until commit, so model it as an explicit empty side.
    const left: ComparisonSide =
      !revision || revision === "0"
        ? emptySide(checkedRight.path)
        : {
            source: "cvs",
            path: checkedRight.path,
            revision,
            label: "revision",
          };
    // A locally removed CVS file still has an Entries revision.  Its right
    // side is explicitly empty, just like a deleted Git working-tree file.
    const right = (await cvsWorktreeExists(this.root, checkedRight.path))
      ? checkedRight
      : emptySide(checkedRight.path);
    return {
      kind: "cvs",
      source: selectedRevision ? "history" : "working",
      filePath: checkedRight.path,
      title: vscode.l10n.t(
        "{0} ({1} ↔ Working copy)",
        filename(checkedRight.path),
        revision,
      ),
      left,
      right,
    };
  }

  async materialize(
    comparison: ResolvedComparison,
    signal?: AbortSignal,
  ): Promise<MaterializedComparison> {
    return materialize(comparison, async (side) => {
      if (side.source === "empty") return Buffer.alloc(0);
      if (side.source === "cvs")
        return this.cvs.content(side.path, side.revision ?? "", signal, {
          maxBytes: COMPARISON_MAX_BYTES,
        });
      await checkedCvsWorktreeSide(this.root, side.path);
      const realRoot = await fs.realpath(this.root);
      return readLimitedFile(path.join(realRoot, side.path));
    });
  }
}

async function cvsWorktreeExists(
  root: string,
  filePath: string,
): Promise<boolean> {
  const realRoot = await fs.realpath(root);
  try {
    await fs.lstat(path.join(realRoot, filePath));
    return true;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw error;
  }
}

async function materialize(
  comparison: ResolvedComparison,
  read: (side: ComparisonSide) => Promise<Buffer>,
): Promise<MaterializedComparison> {
  const [leftContent, rightContent] = await Promise.all([
    readSide(comparison.left, read),
    readSide(comparison.right, read),
  ]);
  return { ...comparison, leftContent, rightContent };
}

async function readSide(
  side: ComparisonSide,
  read: (side: ComparisonSide) => Promise<Buffer>,
): Promise<ComparisonMaterialization> {
  let bytes: Buffer;
  try {
    bytes = await read(side);
  } catch (error) {
    if (
      error instanceof GitContentTooLargeError ||
      comparisonReadError(error) === "outputLimit"
    )
      return { available: false, reason: "tooLarge" };
    throw error;
  }
  if (bytes.byteLength > COMPARISON_MAX_BYTES)
    return { available: false, reason: "tooLarge" };
  if (bytes.includes(0)) return { available: false, reason: "binary" };
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return { available: false, reason: "undecodable" };
  }
  const lines = text === "" ? 0 : text.split("\n").length;
  if (lines > COMPARISON_MAX_LINES)
    return { available: false, reason: "tooManyLines" };
  return { available: true, text, bytes: bytes.byteLength, lines };
}

async function readLimitedFile(target: string): Promise<Buffer> {
  const stat = await fs.stat(target);
  if (!stat.isFile())
    throw new Error(vscode.l10n.t("A regular file is required for preview"));
  if (stat.size > COMPARISON_MAX_BYTES) throw new GitContentTooLargeError();
  const handle = await fs.open(target, "r");
  try {
    const buffer = Buffer.alloc(COMPARISON_MAX_BYTES + 1);
    let total = 0;
    while (total < buffer.length) {
      const { bytesRead } = await handle.read(
        buffer,
        total,
        buffer.length - total,
        total,
      );
      if (!bytesRead) break;
      total += bytesRead;
    }
    if (total > COMPARISON_MAX_BYTES) throw new GitContentTooLargeError();
    return buffer.subarray(0, total);
  } finally {
    await handle.close();
  }
}

function comparisonReadError(error: unknown): string | undefined {
  return typeof error === "object" && error !== null && "code" in error
    ? String(error.code)
    : undefined;
}
