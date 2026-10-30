import * as vscode from "vscode";
import {
  GitComparisonResolver,
  type ResolvedComparison,
} from "../comparison/resolver";
import type { GitService } from "../git/gitService";
import { resolveWorktreePath } from "../git/security";
import type { DiffFile } from "../git/types";
import { assertOwnedPath } from "../repositories/boundaries.cjs";
import { gitRevisionUri } from "./gitContentProvider";

export class DiffEditorManager {
  /** Current diff navigation state */
  private diffFiles: DiffFile[] = [];
  private diffCommit = "";
  private diffIndex = -1;
  private diffBaseRef?: string;
  private diffCherryPickHashes?: string[];

  constructor(
    private readonly gitService: GitService,
    private readonly repositoryId: string,
    private readonly repositoryRoot?: string,
  ) {}

  /**
   * The session uses this for both the native working-file action and inline
   * preview.  Keeping it here prevents HEAD↔index and HEAD↔disk from drifting.
   */
  async resolveWorkingComparison(
    filePath: string,
    staged: boolean,
  ): Promise<ResolvedComparison> {
    if (!this.repositoryRoot) {
      throw new Error(
        vscode.l10n.t("A repository root is required for worktree comparisons"),
      );
    }
    return new GitComparisonResolver(
      this.gitService,
      this.repositoryRoot,
    ).working(filePath, staged);
  }

  /** Set the file list for diff navigation */
  setDiffFileList(
    files: DiffFile[],
    commit: string,
    baseRef?: string,
    cherryPickHashes?: string[],
  ): void {
    this.diffFiles = files;
    this.diffCommit = commit;
    this.diffBaseRef = baseRef;
    this.diffCherryPickHashes = cherryPickHashes;
    this.diffIndex = -1;
  }

  /** Set current index (when opening a specific file) */
  setCurrentIndex(index: number): void {
    this.diffIndex = index;
  }

  /** Navigate to next file diff */
  async nextDiff(): Promise<boolean> {
    if (this.diffFiles.length === 0) {
      void vscode.window.setStatusBarMessage(
        `$(info) ${vscode.l10n.t("No file list available. Open a diff from Changed Files first.")}`,
        3000,
      );
      return false;
    }
    this.diffIndex = Math.min(this.diffIndex + 1, this.diffFiles.length - 1);
    await this.openCurrentDiff();
    return true;
  }

  /** Navigate to previous file diff */
  async prevDiff(): Promise<boolean> {
    if (this.diffFiles.length === 0) {
      void vscode.window.setStatusBarMessage(
        `$(info) ${vscode.l10n.t("No file list available. Open a diff from Changed Files first.")}`,
        3000,
      );
      return false;
    }
    this.diffIndex = Math.max(this.diffIndex - 1, 0);
    await this.openCurrentDiff();
    return true;
  }

  private async openCurrentDiff(): Promise<void> {
    const file = this.diffFiles[this.diffIndex];
    if (!file) return;
    const filePath = file.newPath || file.oldPath;

    // Show status message
    const total = this.diffFiles.length;
    const current = this.diffIndex + 1;
    void vscode.window.setStatusBarMessage(
      `$(arrow-right) ${vscode.l10n.t("File {0}/{1}: {2}  —  Press again to go to the next file", current, total, filePath.split("/").pop() ?? filePath)}`,
      5000,
    );

    await this.openDiffEditor(
      this.diffCommit,
      filePath,
      file,
      this.diffBaseRef,
      this.diffCherryPickHashes,
    );
  }

  async openDiffEditor(
    commit: string,
    filePath: string,
    fileMeta?: DiffFile,
    baseRef?: string,
    cherryPickHashes?: string[],
  ): Promise<void> {
    const comparison = await new GitComparisonResolver(
      this.gitService,
      this.repositoryRoot ?? "",
    ).history(commit, filePath, fileMeta, baseRef, cherryPickHashes);
    await this.openResolvedComparison(comparison);
  }

  /**
   * Open exactly the sides the preview resolver produced.  A worktree side is
   * revalidated immediately before VS Code receives a file URI, preventing a
   * path/symlink change between comparison resolution and native opening.
   */
  async openResolvedComparison(comparison: ResolvedComparison): Promise<void> {
    const leftUri = await this.nativeUri(comparison.left);
    const rightUri = await this.nativeUri(comparison.right);
    await vscode.commands.executeCommand(
      "vscode.diff",
      leftUri,
      rightUri,
      comparison.title,
    );
  }

  private async nativeUri(
    side: ResolvedComparison["left"],
  ): Promise<vscode.Uri> {
    if (side.source !== "worktree")
      return nativeGitUri(this.repositoryId, side);
    if (!this.repositoryRoot) {
      throw new Error(
        vscode.l10n.t(
          "A repository root is required for a worktree comparison side",
        ),
      );
    }
    const filePath = await resolveWorktreePath(this.repositoryRoot, side.path, {
      allowMissing: false,
    });
    await assertOwnedPath(this.repositoryRoot, "git", side.path);
    return vscode.Uri.file(filePath);
  }
}

/** Convert a checked Git comparison side into the existing repository URI. */
export function nativeGitUri(
  repositoryId: string,
  side: Pick<ResolvedComparison["left"], "path" | "source" | "revision">,
): vscode.Uri {
  // Native historical views never receive a disk side.  Do not turn a
  // repository-relative preview path into a file URI without the session's
  // ownership/root validation.
  if (side.source === "worktree") {
    throw new Error(
      vscode.l10n.t(
        "A worktree comparison side requires the session path guard",
      ),
    );
  }
  return gitRevisionUri(
    repositoryId,
    side.path,
    side.source === "empty" ? "empty" : (side.revision ?? "empty"),
  );
}
