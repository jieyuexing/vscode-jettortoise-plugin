import * as path from "node:path";
import * as vscode from "vscode";
import { assertOwnedPath, within } from "../repositories/boundaries.cjs";
import { boundaryErrorText } from "../repositories/navigation";
import type { RepositoryDescriptor } from "../repositories/types";
import type { RefreshRequest, ScmAdapter, ScmChange } from "./types";

export type GroupId =
  | "changes"
  | "deferred"
  | "untracked"
  | "conflicts"
  | "remote";
export interface ScmResource extends vscode.SourceControlResourceState {
  change: ScmChange;
  owner: RepositoryScm;
}
export class RepositoryScm implements vscode.Disposable {
  readonly sourceControl: vscode.SourceControl;
  readonly groups = new Map<GroupId, vscode.SourceControlResourceGroup>();
  readonly changes = new Map<string, ScmChange>();
  private readonly deferred: Set<string>;
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private running?: Promise<void>;
  private pending?: RefreshRequest;
  private targeted = Promise.resolve();
  private version = 0;
  private readonly fileVersions = new Map<string, number>();
  private paths = new Set<string>();
  private timer?: ReturnType<typeof setTimeout>;
  private saving = Promise.resolve();
  private error?: string;
  constructor(
    readonly repository: RepositoryDescriptor,
    private readonly adapter: ScmAdapter,
    private readonly context: vscode.ExtensionContext,
    private readonly decorations: vscode.EventEmitter<vscode.Uri[]>,
  ) {
    this.deferred = new Set(
      context.workspaceState?.get<string[]>(
        `scm.deferred.${repository.id}`,
        [],
      ) ?? [],
    );
    this.sourceControl = vscode.scm.createSourceControl(
      "jettortoise",
      `${path.basename(repository.root)} [${repository.kind === "git" ? "Git" : "CVS"}]`,
      vscode.Uri.file(repository.root),
    );
    const labels: Array<[GroupId, string]> = [
      ["changes", vscode.l10n.t("Changes")],
      ["deferred", vscode.l10n.t("Do Not Commit")],
      ["untracked", vscode.l10n.t("Unversioned Files")],
      ["conflicts", vscode.l10n.t("Conflicts")],
    ];
    if (repository.kind === "cvs")
      labels.push(["remote", vscode.l10n.t("Remote Updates")]);
    for (const [id, label] of labels) {
      const group = this.sourceControl.createResourceGroup(id, label);
      group.hideWhenEmpty = true;
      this.groups.set(id, group);
    }
    this.sourceControl.inputBox.placeholder = vscode.l10n.t(
      "Commit message (commit all files in Changes)",
    );
    this.sourceControl.acceptInputCommand = {
      command: "jettortoise.scm.commit",
      title: vscode.l10n.t("Commit"),
      arguments: [this.sourceControl],
    };
    this.sourceControl.quickDiffProvider = {
      provideOriginalResource: async (uri) =>
        this.disposed ? undefined : this.adapter.baseline(uri),
    };
    const watcher = vscode.workspace.createFileSystemWatcher(
      new vscode.RelativePattern(repository.root, "**/*"),
    );
    const changed = (uri: vscode.Uri) => this.changedFile(uri);
    this.disposables.push(
      watcher,
      watcher.onDidChange(changed),
      watcher.onDidCreate(changed),
      watcher.onDidDelete(changed),
      vscode.workspace.onDidSaveTextDocument((document) =>
        changed(document.uri),
      ),
      adapter.onDidChange(() => {
        void this.refresh(true);
      }),
    );
    if (adapter.onDidRefresh)
      this.disposables.push(
        adapter.onDidRefresh((changes) => this.publish(changes)),
      );
    void this.refresh(true);
  }
  private changedFile(uri: vscode.Uri) {
    if (
      this.disposed ||
      uri.scheme !== "file" ||
      !within(this.repository.root, uri.fsPath)
    )
      return;
    const relative = path
      .relative(this.repository.root, uri.fsPath)
      .split(path.sep)
      .join("/");
    if (
      !relative ||
      relative.split("/").some((part) => part === ".git" || part === "CVS")
    )
      return;
    this.fileVersions.set(relative, ++this.version);
    this.paths.add(relative);
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      const paths = [...this.paths];
      this.paths.clear();
      void this.request({ network: false, paths });
    }, 150);
  }
  refresh(network = false): Promise<void> {
    return this.request({ network });
  }
  /** 进行中的全量查询不被打断；所有后续全量请求合并为一轮。 */
  private request(request: RefreshRequest): Promise<void> {
    if (this.disposed) return Promise.resolve();
    if (this.running && request.paths) {
      const paths = request.paths;
      this.targeted = this.targeted
        .catch(() => {})
        .then(async () => {
          if (this.disposed) return;
          const owned: string[] = [];
          for (const file of paths) {
            try {
              await assertOwnedPath(
                this.repository.root,
                this.repository.kind,
                file,
              );
              owned.push(file);
            } catch (error) {
              if ((error as { code?: string }).code !== "NESTED_REPOSITORY")
                throw error;
            }
          }
          if (owned.length)
            await this.adapter.refresh(
              { network: false, paths: owned },
              (changes) => this.publish(changes, owned),
            );
        })
        .catch((error) => {
          this.error =
            boundaryErrorText(error) ??
            (error instanceof Error
              ? error.message
              : vscode.l10n.t("Status refresh failed."));
          this.render();
        });
      return this.targeted;
    }
    if (this.running) {
      if (!this.pending) this.pending = request;
      else
        this.pending = {
          network: this.pending.network || request.network,
          paths:
            this.pending.paths && request.paths
              ? [...new Set([...this.pending.paths, ...request.paths])]
              : undefined,
        };
      return this.running;
    }
    this.running = (async () => {
      let next: RefreshRequest | undefined = request;
      while (next && !this.disposed) {
        const current = next;
        const version = this.version;
        this.pending = undefined;
        try {
          const paths: string[] = [];
          for (const file of current.paths ?? []) {
            try {
              await assertOwnedPath(
                this.repository.root,
                this.repository.kind,
                file,
              );
              paths.push(file);
            } catch (error) {
              if ((error as { code?: string }).code !== "NESTED_REPOSITORY")
                throw error;
            }
          }
          if (!current.paths || paths.length)
            await this.adapter.refresh(
              { ...current, paths: current.paths ? paths : undefined },
              (changes) => {
                this.publish(
                  changes,
                  current.paths ? paths : undefined,
                  version,
                );
              },
            );
        } catch (error) {
          this.error =
            boundaryErrorText(error) ??
            (error instanceof Error
              ? error.message
              : vscode.l10n.t("Status refresh failed."));
          this.render();
        }
        next = this.pending;
      }
    })().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }
  private publish(
    changes: ScmChange[],
    paths?: string[],
    version = this.version,
  ) {
    if (this.disposed) return;
    const before = [...this.changes.keys()];
    const newer = new Map(
      [...this.fileVersions]
        .filter(([, value]) => value > version)
        .map(([file]) => [file, this.changes.get(file)]),
    );
    if (paths) for (const file of paths) this.changes.delete(file);
    else this.changes.clear();
    for (const change of changes) this.changes.set(change.path, change);
    for (const [file, change] of newer) {
      if (change) this.changes.set(file, change);
      else this.changes.delete(file);
    }
    this.error = undefined;
    this.render();
    this.decorations.fire(
      before.map((file) =>
        vscode.Uri.file(path.join(this.repository.root, file)),
      ),
    );
  }
  private render() {
    if (this.disposed) return;
    let pruned = false;
    for (const file of this.deferred)
      if (!this.changes.has(file)) {
        this.deferred.delete(file);
        pruned = true;
      }
    if (pruned) void this.persist();
    for (const [id, group] of this.groups)
      group.resourceStates = [...this.changes.values()]
        .filter((change) => this.group(change) === id)
        .map(
          (change) =>
            ({
              resourceUri: vscode.Uri.file(
                path.join(this.repository.root, change.path),
              ),
              change,
              owner: this,
              contextValue: change.status,
              command: {
                command: "jettortoise.scm.diff",
                title: vscode.l10n.t("Open Diff"),
                arguments: [this.sourceControl, change.path],
              },
              decorations: {
                strikeThrough: change.status === "deleted",
                faded: id === "deferred",
                tooltip: change.detail ?? statusLabel(change.status),
                iconPath: new vscode.ThemeIcon(
                  icon(change.status),
                  new vscode.ThemeColor(color(change.status)),
                ),
              },
            }) satisfies ScmResource,
        );
    const changes = this.groups.get("changes");
    if (changes)
      changes.label = this.error
        ? vscode.l10n.t("Changes — {0}", this.error)
        : vscode.l10n.t("Changes");
    if (changes) changes.hideWhenEmpty = !this.error;
    this.sourceControl.count = [...this.changes.values()].filter(
      (change) => change.status !== "remote",
    ).length;
    this.decorations.fire(
      [...this.changes.keys()].map((file) =>
        vscode.Uri.file(path.join(this.repository.root, file)),
      ),
    );
  }
  private group(change: ScmChange): GroupId {
    if (change.status === "conflicted") return "conflicts";
    if (change.status === "untracked") return "untracked";
    if (change.status === "remote") return "remote";
    return this.deferred.has(change.path) ? "deferred" : "changes";
  }
  private persist(): Promise<void> {
    const value = [...this.deferred];
    this.saving = this.saving
      .catch(() => {})
      .then(async () => {
        await this.context.workspaceState?.update(
          `scm.deferred.${this.repository.id}`,
          value,
        );
      });
    return this.saving;
  }
  async move(paths: string[], deferred: boolean) {
    for (const file of paths) {
      const change = this.changes.get(file);
      if (change && ["changes", "deferred"].includes(this.group(change))) {
        if (deferred) this.deferred.add(file);
        else this.deferred.delete(file);
      }
    }
    await this.persist();
    this.render();
  }
  pathsIn(group: vscode.SourceControlResourceGroup): string[] {
    return group.resourceStates.map(
      (state) => (state as ScmResource).change.path,
    );
  }
  async commit() {
    const message = this.sourceControl.inputBox.value;
    if (!message.trim()) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("Enter a commit message."),
      );
      return;
    }
    const paths = [...this.changes.values()]
      .filter((change) => this.group(change) === "changes")
      .flatMap((change) =>
        change.oldPath ? [change.oldPath, change.path] : [change.path],
      );
    if (!paths.length) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t("There are no files in Changes to commit."),
      );
      return;
    }
    if (await this.adapter.commit([...new Set(paths)], message)) {
      this.sourceControl.inputBox.value = "";
      await this.refresh(true);
    }
  }
  async action(action: string, paths: string[]) {
    if (action === "defer" || action === "include")
      return this.move(paths, action === "defer");
    if (action === "diff") {
      const change = this.changes.get(paths[0]);
      if (change) await this.adapter.diff(change);
      return;
    }
    if (action === "rollback")
      await this.adapter.rollback([
        ...new Set(
          paths.flatMap((file) => {
            const change = this.changes.get(file);
            return change?.oldPath ? [change.oldPath, file] : [file];
          }),
        ),
      ]);
    if (action === "add") await this.adapter.add(paths);
    if (action === "ignore") await this.adapter.ignore(paths);
    await this.refresh(true);
  }
  decoration(uri: vscode.Uri): vscode.FileDecoration | undefined {
    if (uri.scheme !== "file" || !within(this.repository.root, uri.fsPath))
      return;
    const change = this.changes.get(
      path.relative(this.repository.root, uri.fsPath).split(path.sep).join("/"),
    );
    if (change)
      return {
        badge: badge(change.status),
        tooltip: change.detail ?? statusLabel(change.status),
        color: new vscode.ThemeColor(color(change.status)),
      };
  }
  dispose() {
    this.disposed = true;
    if (this.timer) clearTimeout(this.timer);
    for (const disposable of this.disposables) disposable.dispose();
    this.sourceControl.dispose();
    this.decorations.fire(
      [...this.changes.keys()].map((file) =>
        vscode.Uri.file(path.join(this.repository.root, file)),
      ),
    );
  }
}
function color(status: ScmChange["status"]): string {
  return `gitDecoration.${{ modified: "modifiedResource", added: "addedResource", deleted: "deletedResource", renamed: "renamedResource", untracked: "untrackedResource", conflicted: "conflictingResource", remote: "stageModifiedResource" }[status]}Foreground`;
}
function badge(status: ScmChange["status"]): string {
  return {
    modified: "M",
    added: "A",
    deleted: "D",
    renamed: "R",
    untracked: "U",
    conflicted: "!",
    remote: "↓",
  }[status];
}
function icon(status: ScmChange["status"]): string {
  return {
    modified: "diff-modified",
    added: "diff-added",
    deleted: "diff-removed",
    renamed: "diff-renamed",
    untracked: "question",
    conflicted: "warning",
    remote: "cloud-download",
  }[status];
}
function statusLabel(status: ScmChange["status"]): string {
  return {
    modified: vscode.l10n.t("Modified"),
    added: vscode.l10n.t("Added"),
    deleted: vscode.l10n.t("Deleted"),
    renamed: vscode.l10n.t("Renamed"),
    untracked: vscode.l10n.t("Unversioned Files"),
    conflicted: vscode.l10n.t("Conflicts"),
    remote: vscode.l10n.t("Remote Updates"),
  }[status];
}
