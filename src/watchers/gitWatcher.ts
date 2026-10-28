import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import { promisify } from "node:util";
import * as vscode from "vscode";
import type { GitCache } from "../git/cache";
import type { MessageRouter } from "../messages/messageRouter";
import { nearestRepositories, within } from "../repositories/boundaries.cjs";

type Scope = "all" | "branches" | "status" | "mergeState" | "log";
const execFileAsync = promisify(execFile);

export class GitWatcher implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private debounceTimers = new Map<Scope, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly workspaceRoot: string,
    private readonly messageRouter: MessageRouter,
    private readonly cache: GitCache,
    private readonly ensureAvailable?: () => Promise<void>,
    watchFiles = true,
  ) {
    if (watchFiles) this.setupFileWatchers();
    this.setupEditorWatchers();
  }

  private setupFileWatchers(): void {
    const gitBase = vscode.Uri.file(`${this.workspaceRoot}/.git`);

    // .git/HEAD → all
    const headWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(gitBase, "HEAD"),
    );
    headWatcher.onDidChange(() => this.notify("all"));
    headWatcher.onDidCreate(() => this.notify("all"));
    headWatcher.onDidDelete(() => this.notify("all"));
    this.disposables.push(headWatcher);

    // .git/refs/heads/** → branches
    const headsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(gitBase, "refs/heads/**"),
    );
    headsWatcher.onDidChange(() => this.notify("branches"));
    headsWatcher.onDidCreate(() => this.notify("branches"));
    headsWatcher.onDidDelete(() => this.notify("branches"));
    this.disposables.push(headsWatcher);

    // .git/refs/remotes/** → branches
    const remotesWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(gitBase, "refs/remotes/**"),
    );
    remotesWatcher.onDidChange(() => this.notify("branches"));
    remotesWatcher.onDidCreate(() => this.notify("branches"));
    remotesWatcher.onDidDelete(() => this.notify("branches"));
    this.disposables.push(remotesWatcher);

    // .git/refs/tags/** → branches (tags group)
    const tagsWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(gitBase, "refs/tags/**"),
    );
    tagsWatcher.onDidChange(() => this.notify("branches"));
    tagsWatcher.onDidCreate(() => this.notify("branches"));
    tagsWatcher.onDidDelete(() => this.notify("branches"));
    this.disposables.push(tagsWatcher);

    // .git/index → status
    const indexWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(gitBase, "index"),
    );
    indexWatcher.onDidChange(() => this.notify("status"));
    this.disposables.push(indexWatcher);

    // .git/MERGE_HEAD → mergeState
    const mergeHeadWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(gitBase, "MERGE_HEAD"),
    );
    mergeHeadWatcher.onDidChange(() => this.notify("mergeState"));
    mergeHeadWatcher.onDidCreate(() => this.notify("mergeState"));
    mergeHeadWatcher.onDidDelete(() => this.notify("mergeState"));
    this.disposables.push(mergeHeadWatcher);

    // .git/CHERRY_PICK_HEAD → mergeState (cherry-pick state)
    const cherryPickHeadWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(gitBase, "CHERRY_PICK_HEAD"),
    );
    cherryPickHeadWatcher.onDidChange(() => this.notify("mergeState"));
    cherryPickHeadWatcher.onDidCreate(() => this.notify("mergeState"));
    cherryPickHeadWatcher.onDidDelete(() => this.notify("mergeState"));
    this.disposables.push(cherryPickHeadWatcher);

    // .git/rebase-merge/** → mergeState (rebase state)
    const rebaseMergeWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(gitBase, "rebase-merge/**"),
    );
    rebaseMergeWatcher.onDidChange(() => this.notify("mergeState"));
    rebaseMergeWatcher.onDidCreate(() => this.notify("mergeState"));
    rebaseMergeWatcher.onDidDelete(() => this.notify("mergeState"));
    this.disposables.push(rebaseMergeWatcher);

    // .git/rebase-apply/** → mergeState (rebase state)
    const rebaseApplyWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(gitBase, "rebase-apply/**"),
    );
    rebaseApplyWatcher.onDidChange(() => this.notify("mergeState"));
    rebaseApplyWatcher.onDidCreate(() => this.notify("mergeState"));
    rebaseApplyWatcher.onDidDelete(() => this.notify("mergeState"));
    this.disposables.push(rebaseApplyWatcher);

    // .git/COMMIT_EDITMSG → log
    const commitMsgWatcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(gitBase, "COMMIT_EDITMSG"),
    );
    commitMsgWatcher.onDidChange(() => this.notify("log"));
    commitMsgWatcher.onDidCreate(() => this.notify("log"));
    this.disposables.push(commitMsgWatcher);
  }

  private setupEditorWatchers(): void {
    // Save → status refresh
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        void this.routeSavedDocument(document);
      }),
    );
  }

  /**
   * A nested repository owns saves below its real root. The parent only also
   * refreshes if its own native index contains that exact path, which handles
   * intentional overlap without turning every child save into a broadcast.
   */
  private async routeSavedDocument(
    document: vscode.TextDocument,
  ): Promise<void> {
    if (document.uri.scheme !== "file") return;
    try {
      await this.ensureAvailable?.();
      const [root, file] = await Promise.all([
        fs.realpath(this.workspaceRoot),
        fs.realpath(document.uri.fsPath),
      ]);
      if (!within(root, file) || root === file) return;

      const nearest = await nearestRepositories(file);
      if (
        nearest.some(
          (repository) => repository.kind === "git" && repository.root === root,
        )
      ) {
        this.notify("status");
        return;
      }

      const relative = path.relative(root, file);
      if (
        !relative ||
        path.isAbsolute(relative) ||
        relative === ".." ||
        relative.startsWith(`..${path.sep}`)
      ) {
        return;
      }
      if (await this.isExactIndexPath(root, relative)) {
        this.notify("status");
      }
    } catch {
      // A malformed, deleted, untrusted, or non-local path never broadcasts.
    }
  }

  private async isExactIndexPath(
    root: string,
    relative: string,
  ): Promise<boolean> {
    try {
      const { stdout } = await execFileAsync(
        "git",
        ["-C", root, "ls-files", "-z", "--error-unmatch", "--", relative],
        {
          maxBuffer: 64 * 1024,
          env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
        },
      );
      return stdout.split("\0").some((entry) => entry === relative);
    } catch {
      return false;
    }
  }

  private notify(scope: Scope): void {
    // Debounce per scope, 300ms
    const existing = this.debounceTimers.get(scope);
    if (existing) {
      clearTimeout(existing);
    }

    this.debounceTimers.set(
      scope,
      setTimeout(() => {
        this.debounceTimers.delete(scope);
        this.cache.invalidate();
        this.messageRouter.broadcastEvent("gitStateChanged", { scope });
      }, 300),
    );
  }

  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
