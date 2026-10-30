import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { CvsSession } from "../cvs/session";
import { resolveWorktreePath } from "../git/security";
import { createGitRepositorySession } from "../git/session";
import { localizeError } from "../messages/errors";
import { ignorePaths } from "../scm/ignore";
import {
  assertOwnedPath,
  boundariesForPaths,
  nearestRepositories,
  within,
} from "./boundaries.cjs";
import type { ChangeFile, RepositoryInfo, RepositorySnapshot } from "./changes";
import { canCommit } from "./changes";
import { discoverRepositoryRoots } from "./discovery";
import { hasDirtyEditors } from "./editor-documents";
import { repositoryPath, validateRepositoryRequest } from "./requests";

type GitSession = ReturnType<typeof createGitRepositorySession>;
interface Entry {
  info: RepositoryInfo;
  git?: GitSession;
  cvs?: CvsSession;
  snapshot: RepositorySnapshot;
  disposables: vscode.Disposable[];
}
export class RepositoryManager implements vscode.Disposable {
  private readonly revisionChanges = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeRevision = this.revisionChanges.event;
  private readonly revisionUris = new Map<string, vscode.Uri>();
  private readonly requestLiveness = new AsyncLocalStorage<() => void>();
  private readonly entries = new Map<string, Entry>();
  private readonly views = new Set<vscode.Webview>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private roots: string[] = [];
  private scanController?: AbortController;
  private logId?: string;
  private commitId?: string;
  private activeFile?: string;
  private editorOwnerId?: string;
  private disposed = false;
  constructor(private readonly context: vscode.ExtensionContext) {
    this.disposables.push(
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.scan();
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        void this.scan();
      }),
      vscode.window.onDidChangeActiveTextEditor((editor) => {
        void this.follow(editor?.document.uri);
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused)
          for (const entry of this.entries.values())
            void this.refresh(entry, false);
      }),
      vscode.workspace.onDidSaveTextDocument((document) => {
        void this.saved(document.uri);
      }),
    );
  }
  get repositories() {
    return [...this.entries.values()].map((entry) => entry.info);
  }
  state() {
    return {
      repositories: this.repositories,
      snapshots: [...this.entries.values()].map((entry) => entry.snapshot),
      logRepositoryId: this.logId,
      commitRepositoryId: this.commitId,
      activeFile:
        this.logId === this.editorOwnerId ? this.activeFile : undefined,
    };
  }
  broadcast(event: string, data: unknown) {
    for (const view of this.views)
      void view.postMessage({ type: "event", event, data });
  }
  private publish() {
    this.broadcast("repositoriesChanged", this.state());
  }
  private selected(id?: unknown) {
    const selected = typeof id === "string" ? id : this.logId;
    const entry = selected ? this.entries.get(selected) : undefined;
    if (!entry)
      throw new Error(vscode.l10n.t("Select an available repository."));
    return entry;
  }
  private cvs(entry: Entry) {
    if (!entry.cvs)
      throw new Error(vscode.l10n.t("CVS session is unavailable."));
    return entry.cvs;
  }
  private git(entry: Entry) {
    if (!entry.git)
      throw new Error(vscode.l10n.t("Git session is unavailable."));
    return entry.git;
  }
  private async guard(entry: Entry) {
    this.requestLiveness.getStore()?.();
    if (
      this.disposed ||
      this.entries.get(entry.info.id) !== entry ||
      !vscode.workspace.isTrusted
    )
      throw new Error(
        vscode.l10n.t("Repository is no longer available or trusted."),
      );
    const currentRoots = await Promise.all(
      (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === "file")
        .map((folder) => fs.realpath(folder.uri.fsPath)),
    );
    if (
      !currentRoots.some((root) => within(root, entry.info.root)) ||
      (await fs.realpath(entry.info.root)) !== entry.info.root
    )
      throw new Error(vscode.l10n.t("Repository is outside this workspace."));
    const nearest = await nearestRepositories(entry.info.root);
    if (
      !nearest.some(
        (root) =>
          root.kind === entry.info.kind && root.root === entry.info.root,
      )
    )
      throw new Error(vscode.l10n.t("Repository metadata changed."));
    this.requestLiveness.getStore()?.();
  }
  async scan() {
    this.scanController?.abort();
    const controller = new AbortController();
    this.scanController = controller;
    this.roots = await Promise.all(
      (vscode.workspace.workspaceFolders ?? [])
        .filter((folder) => folder.uri.scheme === "file")
        .map((folder) => fs.realpath(folder.uri.fsPath)),
    );
    for (const [id, entry] of this.entries)
      if (
        !vscode.workspace.isTrusted ||
        !this.roots.some((root) => within(root, entry.info.root))
      )
        this.remove(id);
    if (!vscode.workspace.isTrusted || this.disposed) {
      this.publish();
      return;
    }
    const seen = new Set<string>();
    let incomplete = false;
    for (const root of this.roots) {
      const result = await discoverRepositoryRoots(root, {
        signal: controller.signal,
        onProgress: (progress) => {
          if (controller.signal.aborted || this.disposed) return;
          for (const discovered of progress.roots) {
            const id = this.add(discovered.kind, discovered.root);
            seen.add(id);
          }
        },
      });
      incomplete ||= result.incomplete;
    }
    if (controller.signal.aborted || this.disposed) return;
    if (!incomplete)
      for (const id of this.entries.keys()) if (!seen.has(id)) this.remove(id);
    if (!this.logId || !this.entries.has(this.logId))
      this.logId = this.repositories[0]?.id;
    if (this.commitId && !this.entries.has(this.commitId))
      this.commitId = undefined;
    await this.follow(vscode.window.activeTextEditor?.document.uri);
    this.publish();
  }
  private add(kind: "git" | "cvs", root: string) {
    const id = createHash("sha256")
      .update(`${kind}\0${root}`)
      .digest("hex")
      .slice(0, 32);
    if (this.entries.has(id)) return id;
    const info = { id, kind, root, name: path.basename(root) };
    const entry: Entry = {
      info,
      snapshot: { repositoryId: id, files: [] },
      disposables: [],
    };
    this.entries.set(id, entry);
    const guard = () => this.guard(entry);
    if (kind === "git")
      entry.git = createGitRepositorySession(
        this.context,
        { id, kind, root, title: info.name },
        guard,
        () => {
          this.logId = id;
          this.publish();
        },
        (event, data) => {
          this.broadcast(event, {
            ...(typeof data === "object" && data ? data : {}),
            repositoryId: id,
          });
          if (event === "gitStateChanged" || event === "commitStateChanged") {
            this.schedule(entry);
            this.written(entry);
          }
        },
      );
    else {
      entry.cvs = new CvsSession(id, root, guard, (snapshot) => {
        entry.snapshot = snapshot;
        this.broadcast("repositorySnapshot", snapshot);
      });
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(root, "**/*"),
      );
      for (const subscribe of [
        watcher.onDidChange,
        watcher.onDidCreate,
        watcher.onDidDelete,
      ])
        entry.disposables.push(
          subscribe((uri) => {
            if (uri.path.includes("/CVS/") || uri.path.endsWith("/CVS"))
              this.schedule(entry);
          }),
        );
      entry.disposables.push(watcher);
    }
    this.publish();
    void this.refresh(entry, true);
    return id;
  }
  private remove(id: string) {
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.git?.dispose();
    entry.cvs?.dispose();
    for (const disposable of entry.disposables) disposable.dispose();
    this.entries.delete(id);
    for (const [key, uri] of this.revisionUris)
      if (uri.authority === id) this.revisionUris.delete(key);
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }
  private written(entry: Entry) {
    for (const uri of this.revisionUris.values())
      if (uri.authority === entry.info.id) this.revisionChanges.fire(uri);
    this.broadcast("repositoryWritten", { repositoryId: entry.info.id });
  }
  private schedule(entry: Entry) {
    const id = entry.info.id;
    const old = this.timers.get(id);
    if (old) clearTimeout(old);
    this.timers.set(
      id,
      setTimeout(() => {
        this.timers.delete(id);
        void this.refresh(entry, false);
      }, 250),
    );
  }
  private async refresh(entry: Entry, network: boolean, paths?: string[]) {
    try {
      await this.guard(entry);
      if (entry.cvs) {
        await entry.cvs.refresh(paths, network);
        return;
      }
      const git = this.git(entry);
      git.service.invalidateCache();
      // Git 的未管理目录用 porcelain 的默认目录节点输出，不递归铺开。
      const files = await git.service.getWorkingTreeChanges(undefined, true);
      const changes = files.map((file) => ({
        ...file,
        repositoryId: entry.info.id,
        directory: file.path.endsWith("/"),
        path: file.path.replace(/\/$/, ""),
      })) as ChangeFile[];
      await this.guard(entry);
      entry.snapshot = { repositoryId: entry.info.id, files: changes };
    } catch (error) {
      entry.snapshot = {
        ...entry.snapshot,
        error: localizeError(
          error instanceof Error ? error : "Repository refresh failed.",
        ),
      };
    }
    this.broadcast("repositorySnapshot", entry.snapshot);
  }
  private async owner(uri?: vscode.Uri) {
    if (!uri || uri.scheme !== "file") return;
    const physical = await nearestRepositories(uri.fsPath);
    return [...this.entries.values()].find((entry) =>
      physical.some(
        (root) =>
          root.kind === entry.info.kind && root.root === entry.info.root,
      ),
    );
  }
  private async follow(uri?: vscode.Uri) {
    try {
      const entry = await this.owner(uri);
      if (!entry || !uri) return;
      await this.guard(entry);
      this.logId = entry.info.id;
      this.editorOwnerId = entry.info.id;
      this.activeFile = path
        .relative(entry.info.root, uri.fsPath)
        .split(path.sep)
        .join("/");
      this.publish();
    } catch {
      /* 文件关闭或工作区移除时保留当前选择。 */
    }
  }
  private async saved(uri: vscode.Uri) {
    try {
      const entry = await this.owner(uri);
      if (entry?.cvs) {
        const name = path
          .relative(entry.info.root, uri.fsPath)
          .split(path.sep)
          .join("/");
        await this.refresh(entry, false, [name]);
      }
    } catch {
      /* 保存刷新错误由仓库快照显示。 */
    }
  }
  connect(view: vscode.Webview): vscode.Disposable {
    this.views.add(view);
    const subscription = view.onDidReceiveMessage(async (raw: unknown) => {
      if (!raw || typeof raw !== "object") return;
      const msg = raw as {
        type?: unknown;
        id?: unknown;
        command?: unknown;
        params?: unknown;
      };
      if (
        msg.type !== "request" ||
        typeof msg.id !== "string" ||
        typeof msg.command !== "string" ||
        !msg.params ||
        typeof msg.params !== "object" ||
        Array.isArray(msg.params)
      )
        return;
      try {
        if (
          Object.keys(msg).some(
            (key) => !["type", "id", "command", "params"].includes(key),
          )
        )
          throw new Error(vscode.l10n.t("Unexpected message field."));
        const data = await this.request(
          msg.command,
          msg.params as Record<string, unknown>,
          () => {
            if (!this.views.has(view))
              throw new Error(vscode.l10n.t("Webview is no longer active."));
          },
        );
        if (this.views.has(view))
          void view.postMessage({
            type: "response",
            id: msg.id,
            success: true,
            data,
          });
      } catch (error) {
        if (this.views.has(view))
          void view.postMessage({
            type: "response",
            id: msg.id,
            success: false,
            error: {
              code: "UNKNOWN",
              message: localizeError(
                error instanceof Error ? error : "Request failed.",
              ),
            },
          });
      }
    });
    return {
      dispose: () => {
        subscription.dispose();
        this.views.delete(view);
      },
    };
  }
  request(
    command: string,
    params: Record<string, unknown> = {},
    ensureLive: () => void = () => {},
  ) {
    return this.requestLiveness.run(ensureLive, () =>
      this.dispatch(command, params),
    );
  }
  private async dispatch(command: string, params: Record<string, unknown>) {
    this.requestLiveness.getStore()?.();
    validateRepositoryRequest(command, params);
    const { repositoryId, ...values } = params;
    if (["cwd", "root", "repository"].some((key) => Object.hasOwn(values, key)))
      throw new Error(vscode.l10n.t("A view cannot choose a repository path."));
    if (command === "getRepositories") return this.state();
    if (command === "selectRepository") {
      const entry = this.selected(repositoryId);
      await this.guard(entry);
      if (values.surface === "commit") this.commitId = entry.info.id;
      else this.logId = entry.info.id;
      this.publish();
      return this.state();
    }
    if (command === "getRepositoryChanges") return this.state();
    if (command === "refreshRepositories") {
      await Promise.all(
        [...this.entries.values()].map((entry) => this.refresh(entry, true)),
      );
      return this.state();
    }
    if (command === "commitRepositories") return this.commit(values);
    const entry = this.selected(
      repositoryId ?? (command === "updateProject" ? this.commitId : undefined),
    );
    await this.guard(entry);
    if (command === "updateProject") {
      try {
        await (entry.git?.update() ?? this.cvs(entry).update());
        return { success: true };
      } finally {
        await this.refresh(entry, true);
        this.written(entry);
      }
    }
    if (command === "expandUnversioned")
      return this.expand(entry, repositoryPath(values.filePath));
    if (command === "ignoreUnversioned") {
      const files = this.paths(values.filePaths);
      await this.requireUnversioned(entry, files);
      const action = async () => {
        await this.guard(entry);
        if (await hasDirtyEditors(entry.info.root))
          throw new Error(
            vscode.l10n.t("Save unsaved editors before editing ignore files."),
          );
        await this.requireUnversioned(entry, files);
        await ignorePaths(entry.info.root, entry.info.kind, files, () =>
          this.guard(entry),
        );
      };
      if (entry.git) await entry.git.mutate(command, action);
      else
        await this.cvs(entry).operate(
          vscode.l10n.t("CVS Ignore"),
          action,
          true,
        );
      await this.refresh(entry, true);
      return { success: true };
    }
    if (command === "addUnversioned") {
      const files = this.paths(values.filePaths);
      await this.requireUnversioned(entry, files);
      if (entry.cvs) await entry.cvs.add(files);
      else
        await this.git(entry).router.request("stageFile", {
          filePath: files[0],
        });
      await this.refresh(entry, true);
      return { success: true };
    }
    if (entry.git) return entry.git.router.request(command, values);
    const cvs = this.cvs(entry);
    if (command === "getCvsHistory")
      return cvs.history(repositoryPath(values.filePath));
    if (command === "diffCvsRevision")
      return cvs.revisionDiff(
        repositoryPath(values.filePath),
        String(values.revision),
      );
    if (command === "getCvsFiles")
      return await cvs.operate(vscode.l10n.t("CVS files"), async (adapter) => {
        const files = await adapter.localStatus();
        return files
          .filter((file) => file.entryRevision)
          .map((file) => file.newPath);
      });
    if (command === "showDiffForWorkingFile")
      return cvs.diff(repositoryPath(values.filePath));
    if (command === "rollbackFiles" || command === "openRollbackPanel") {
      const files =
        command === "openRollbackPanel"
          ? (values.files as Array<{ path: string }>).map((file) => file.path)
          : this.paths(values.filePaths);
      try {
        await cvs.rollback(files);
      } finally {
        await this.refresh(entry, true);
        this.written(entry);
      }
      return { success: true };
    }
    if (command === "openFile") {
      const file = repositoryPath(values.filePath);
      await assertOwnedPath(entry.info.root, "cvs", file);
      return vscode.window.showTextDocument(
        vscode.Uri.file(await resolveWorktreePath(entry.info.root, file)),
      );
    }
    if (
      ["getShelves", "getIdeaShelves", "getRecentCommitMessages"].includes(
        command,
      )
    )
      return [];
    if (command === "getRebaseState") return { isRebasing: false };
    if (command === "getMergeState") return { isMerging: false };
    if (command === "getCherryPickState") return { isCherryPicking: false };
    throw new Error(
      vscode.l10n.t("This action is available for Git repositories only."),
    );
  }
  private paths(value: unknown) {
    if (!Array.isArray(value) || !value.length || value.length > 2000)
      throw new Error(vscode.l10n.t("Select files."));
    return value.map((item) => repositoryPath(item));
  }
  private async requireUnversioned(entry: Entry, paths: string[]) {
    await this.refresh(entry, false);
    for (const file of paths)
      if (
        !entry.snapshot.files.some(
          (change) =>
            change.status === "untracked" &&
            (change.path === file ||
              (change.directory && file.startsWith(`${change.path}/`))),
        )
      )
        throw new Error(
          vscode.l10n.t("Ignore/Add applies to unversioned entries only."),
        );
  }
  private async commit(values: Record<string, unknown>) {
    if (
      typeof values.message !== "string" ||
      !values.message.trim() ||
      values.message.length > 16000 ||
      values.message.includes("\0")
    )
      throw new Error(vscode.l10n.t("Enter a commit message."));
    const selected = values.files as Array<{
      repositoryId: string;
      path: string;
    }>;
    if (!Array.isArray(selected) || !selected.length || selected.length > 2000)
      throw new Error(vscode.l10n.t("Select changed files."));
    const grouped = new Map<Entry, ChangeFile[]>();
    for (const file of selected) {
      const entry = this.selected(file.repositoryId);
      const name = repositoryPath(file.path);
      const group = grouped.get(entry) ?? [];
      if (!group.some((change) => change.path === name))
        group.push({
          repositoryId: entry.info.id,
          path: name,
          status: "modified",
          staged: false,
        });
      grouped.set(entry, group);
    }
    // 所有仓库先验证；实际提交仍逐仓独立，失败保留已成功仓库回执。
    for (const [entry, files] of grouped) {
      await this.guard(entry);
      await this.refresh(entry, false);
      if (entry.snapshot.error) throw new Error(entry.snapshot.error);
      for (const file of files) {
        const current = entry.snapshot.files.find(
          (change) => change.path === file.path,
        );
        if (!current || !canCommit(current))
          throw new Error(
            vscode.l10n.t(
              "{0}: selected file cannot be committed: {1}",
              entry.info.name,
              file.path,
            ),
          );
        Object.assign(file, current);
        await assertOwnedPath(entry.info.root, entry.info.kind, file.path);
      }
    }
    if (values.amend && (grouped.size !== 1 || ![...grouped.keys()][0].git))
      throw new Error(
        vscode.l10n.t("Amend is available for one Git repository only."),
      );
    const completed: string[] = [];
    for (const [entry, files] of grouped) {
      try {
        await this.guard(entry);
        const paths = [
          ...new Set(
            files.flatMap((file) =>
              file.oldPath ? [file.oldPath, file.path] : [file.path],
            ),
          ),
        ];
        if (entry.git)
          await entry.git.commit(paths, values.message, values.amend === true);
        else await this.cvs(entry).commit(paths, values.message);
        completed.push(entry.info.id);
      } catch (error) {
        throw new Error(
          vscode.l10n.t(
            "{0}: {1}. Completed repositories: {2}.",
            entry.info.name,
            localizeError(
              error instanceof Error ? error : vscode.l10n.t("Commit failed"),
            ),
            completed.map((id) => this.entries.get(id)?.info.name).join(", ") ||
              vscode.l10n.t("none"),
          ),
        );
      } finally {
        await this.refresh(entry, true);
        this.written(entry);
      }
    }
    return { success: true, completed };
  }
  private async expand(entry: Entry, name: string) {
    await this.requireUnversioned(entry, [name]);
    const target = await resolveWorktreePath(entry.info.root, name, {
      allowMissing: false,
    });
    const nodes = await fs.readdir(target, { withFileTypes: true });
    const files: ChangeFile[] = [];
    for (const node of nodes) {
      if (node.isSymbolicLink() || [".git", "CVS"].includes(node.name))
        continue;
      const file = `${name}/${node.name}`;
      if (
        (await boundariesForPaths(entry.info.root, entry.info.kind, [file]))
          .length
      )
        continue;
      files.push({
        repositoryId: entry.info.id,
        path: file,
        status: "untracked",
        staged: false,
        directory: node.isDirectory(),
      });
    }
    return files;
  }
  async readFile(uri: vscode.Uri) {
    const entry = this.selected(uri.authority);
    await this.guard(entry);
    const content = await (entry.git
      ? entry.git.readFile(uri)
      : this.cvs(entry).readFile(uri));
    this.revisionUris.set(uri.toString(), uri);
    return content;
  }
  async execute(command: string, ...args: unknown[]) {
    if (
      [
        "jettortoise.updateProject",
        "jettortoise.openCommitPanel",
        "jettortoise.openHistory",
        "jettortoise.showFileHistory",
      ].includes(command)
    ) {
      const uri =
        (args[0] as vscode.Uri | undefined) ??
        vscode.window.activeTextEditor?.document.uri;
      const entry = uri
        ? await this.owner(uri)
        : this.selected(
            command === "jettortoise.openCommitPanel" ||
              command === "jettortoise.updateProject"
              ? this.commitId
              : undefined,
          );
      if (!entry)
        throw new Error(vscode.l10n.t("Select an available repository."));
      await this.guard(entry);
      if (command === "jettortoise.updateProject")
        return this.request("updateProject", { repositoryId: entry.info.id });
      if (command === "jettortoise.openCommitPanel") {
        this.commitId = entry.info.id;
        this.publish();
        await vscode.commands.executeCommand("jettortoise.commitPanel.focus");
        return;
      }
      this.logId = entry.info.id;
      this.editorOwnerId = undefined;
      this.activeFile = undefined;
      if (command === "jettortoise.showFileHistory" && uri) {
        const file = await fs.realpath(uri.fsPath);
        if ((await fs.stat(file)).isFile()) {
          this.activeFile = path
            .relative(entry.info.root, file)
            .split(path.sep)
            .join("/");
          this.editorOwnerId = entry.info.id;
        }
      }
      this.publish();
      await vscode.commands.executeCommand("jettortoise.gitLog.focus");
      if (entry.info.kind === "git")
        this.broadcast("showFileHistory", {
          repositoryId: entry.info.id,
          file: this.activeFile ?? "",
        });
      return;
    }
    return this.selected().git?.execute(
      command.replace("jettortoise.", "jettortoise.git."),
      ...args,
    );
  }
  dispose() {
    this.disposed = true;
    this.scanController?.abort();
    for (const id of this.entries.keys()) this.remove(id);
    for (const item of this.disposables) item.dispose();
    this.views.clear();
    this.revisionChanges.dispose();
    this.revisionUris.clear();
  }
}
