import { AsyncLocalStorage } from "node:async_hooks";
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { CvsSession, createCvsCacheStore } from "../cvs/session";
import { type DivergedUpstream, divergedMessage } from "../git/gitService";
import { resolveWorktreePath } from "../git/security";
import { createGitRepositorySession } from "../git/session";
import { isScanLimit, localizeError } from "../messages/errors";
import { ignorePaths } from "../scm/ignore";
import { clearFileIconCache, getFileIcons } from "../views/file-icons";
import {
  assertOwnedPath,
  boundariesForPaths,
  NestedRepositoryError,
  nearestRepositories,
  within,
} from "./boundaries.cjs";
import type { ChangeFile, RepositoryInfo, RepositorySnapshot } from "./changes";
import { canCommit, compareRepositories, snapshotDelta } from "./changes";
import {
  discoverRepositoryRoots,
  isCvsSyncRoot,
  readRepositoryReference,
} from "./discovery";
import { hasDirtyEditors, revisionContent } from "./editor-documents";
import { repositoryPath, validateRepositoryRequest } from "./requests";

type GitSession = ReturnType<typeof createGitRepositorySession>;
// 日志面板的只读历史请求，未同步 CVS 也可用。
const LOG_COMMANDS = new Set([
  "getCvsFiles",
  "getCvsHistory",
  "getCvsLog",
  "getCvsCommit",
  "diffCvsRevision",
  "compareCvsWorkingFile",
  "openFile",
]);
interface Entry {
  info: RepositoryInfo;
  git?: GitSession;
  cvs?: CvsSession;
  snapshot: RepositorySnapshot;
  disposables: vscode.Disposable[];
  scanStopped?: boolean;
  refreshTask?: Promise<void>;
}
export class RepositoryManager implements vscode.Disposable {
  private readonly revisionChanges = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChangeRevision = this.revisionChanges.event;
  private readonly revisionUris = new Map<string, vscode.Uri>();
  private readonly requestLiveness = new AsyncLocalStorage<() => void>();
  private readonly entries = new Map<string, Entry>();
  private readonly publishedSnapshots = new Map<string, RepositorySnapshot>();
  private readonly views = new Set<vscode.Webview>();
  private readonly disposables: vscode.Disposable[] = [];
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private roots: string[] = [];
  private syncRoots = new Set<string>();
  private scanController?: AbortController;
  private logId?: string;
  private commitId?: string;
  private activeFile?: string;
  private historyRequest?: { repositoryId: string; sequence: number };
  private historySequence = 0;
  private editorOwnerId?: string;
  private disposed = false;
  private publishTimer?: ReturnType<typeof setTimeout>;
  private discoveryTimer?: ReturnType<typeof setTimeout>;
  private localActive = 0;
  private readonly localWaiters: (() => void)[] = [];
  private readonly streams = new Map<vscode.Webview, Map<string, symbol>>();
  // 仓库日志、单文件历史与修订内容的落盘缓存；没有扩展存储目录时不落盘。
  private readonly cvsCache?: ReturnType<typeof createCvsCacheStore>;
  constructor(private readonly context: vscode.ExtensionContext) {
    if (context.globalStorageUri)
      this.cvsCache = createCvsCacheStore(
        path.join(context.globalStorageUri.fsPath, "cvs-cache"),
      );
    const configuration = vscode.workspace.onDidChangeConfiguration?.(
      (event) => {
        if (event.affectsConfiguration("workbench.iconTheme")) {
          clearFileIconCache();
          this.broadcast("fileIconsChanged", {});
        }
      },
    );
    if (configuration) this.disposables.push(configuration);
    // 运行中新签出的工作副本（出现 CVS/Root 或 .git）重新发现，无需重开窗口。
    for (const pattern of ["**/CVS/Root", "**/.git"]) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        pattern,
        false,
        true,
        true,
      );
      this.disposables.push(
        watcher,
        watcher.onDidCreate((uri) => void this.created(uri)),
      );
    }
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
  private listed(entry: Entry) {
    return entry.info.kind === "git" || entry.info.syncedAt !== undefined;
  }
  get repositories() {
    return [...this.entries.values()]
      .filter((entry) => this.listed(entry))
      .map((entry) => entry.info)
      .sort(compareRepositories);
  }
  // 日志列出全部已发现仓库：未同步 CVS 只查文件历史，不进入本地更改、扫描或刷新。
  get logRepositories() {
    return [...this.entries.values()]
      .map((entry) => entry.info)
      .sort(compareRepositories);
  }
  state() {
    return {
      repositories: this.repositories,
      logRepositories: this.logRepositories,
      snapshots: [...this.entries.values()]
        .filter((entry) => this.listed(entry))
        .map((entry) => entry.snapshot),
      unsyncedCvsCount: [...this.entries.values()].filter(
        (entry) =>
          entry.info.kind === "cvs" &&
          !this.listed(entry) &&
          this.syncRoots.has(entry.info.root),
      ).length,
      logRepositoryId: this.logId,
      commitRepositoryId: this.commitId,
      historyRequest: this.historyRequest,
      activeFile:
        this.logId === this.editorOwnerId ? this.activeFile : undefined,
    };
  }
  broadcast(event: string, data: unknown) {
    for (const view of this.views)
      void view.postMessage({ type: "event", event, data });
  }
  private metadata() {
    const { snapshots: _snapshots, ...metadata } = this.state();
    return metadata;
  }
  private publish() {
    if (this.publishTimer || this.disposed) return;
    this.publishTimer = setTimeout(() => {
      this.publishTimer = undefined;
      if (!this.disposed) this.broadcast("repositoryList", this.metadata());
    }, 50);
  }
  private summary(snapshot: RepositorySnapshot): RepositorySnapshot {
    return {
      ...snapshot,
      files: [],
      refreshing: snapshot.files.length > 0 || snapshot.refreshing,
    };
  }
  summaryState(workspace = this.state()) {
    return {
      ...workspace,
      snapshots: workspace.snapshots.map((snapshot) => this.summary(snapshot)),
    };
  }
  private async streamSnapshot(
    view: vscode.Webview,
    snapshot: RepositorySnapshot,
  ) {
    const streams = this.streams.get(view);
    if (!streams) return;
    const token = Symbol();
    streams.set(snapshot.repositoryId, token);
    await view.postMessage({
      type: "event",
      event: "repositorySnapshot",
      data: this.summary(snapshot),
    });
    for (let start = 0; start < snapshot.files.length; start += 5000) {
      // 让摘要先绘制；每批只携带有界文件，关闭或新快照会取消旧批次。
      await new Promise((resolve) => setTimeout(resolve, 16));
      if (
        this.streams.get(view) !== streams ||
        streams.get(snapshot.repositoryId) !== token
      )
        return;
      const { files, ...metadata } = snapshot;
      await view.postMessage({
        type: "event",
        event: "repositorySnapshotDelta",
        data: {
          ...metadata,
          changed: files.slice(start, start + 5000),
          removed: [],
          refreshing: start + 5000 < files.length || snapshot.refreshing,
        },
      });
    }
    if (streams.get(snapshot.repositoryId) === token)
      streams.delete(snapshot.repositoryId);
  }
  private publishSnapshot(snapshot: RepositorySnapshot) {
    const previous = this.publishedSnapshots.get(snapshot.repositoryId);
    this.publishedSnapshots.set(snapshot.repositoryId, snapshot);
    const delta = previous ? snapshotDelta(previous, snapshot) : undefined;
    for (const view of this.views) {
      if (
        (this.streams.get(view)?.has(snapshot.repositoryId) && delta) ||
        (snapshot.files.length > 5000 &&
          (!previous ||
            (delta?.changed.length ?? 0) > 5000 ||
            (delta?.removed.length ?? 0) > 5000))
      ) {
        void this.streamSnapshot(view, snapshot);
      } else if (!previous) {
        void view.postMessage({
          type: "event",
          event: "repositorySnapshot",
          data: snapshot,
        });
      } else if (delta) {
        this.streams.get(view)?.delete(snapshot.repositoryId);
        void view.postMessage({
          type: "event",
          event: "repositorySnapshotDelta",
          data: delta,
        });
      }
    }
  }
  // log 为真时只服务日志的只读查询，允许未同步 CVS；其余请求仍要求已同步。
  private selected(id?: unknown, log = false) {
    const selected =
      typeof id === "string" ? id : log ? this.logId : this.commitFallback();
    const entry = selected ? this.entries.get(selected) : undefined;
    if (!entry || (!log && !this.listed(entry)))
      throw new Error(vscode.l10n.t("Select an available repository."));
    return entry;
  }
  // 提交面没有明确选仓时沿用日志所选仓；日志选中未同步 CVS 时改用第一个可用仓库。
  private commitFallback() {
    const entry = this.logId ? this.entries.get(this.logId) : undefined;
    return entry && this.listed(entry)
      ? entry.info.id
      : this.repositories[0]?.id;
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
    this.syncRoots = new Set(
      (
        await Promise.all(
          [...this.entries.values()]
            .filter((entry) => entry.info.kind === "cvs")
            .map(async (entry) =>
              (await isCvsSyncRoot(entry.info.root))
                ? entry.info.root
                : undefined,
            ),
        )
      ).filter((root): root is string => root !== undefined),
    );
    await vscode.commands.executeCommand(
      "setContext",
      "jettortoise.cvsSyncRoots",
      [...this.syncRoots].map((root) => vscode.Uri.file(root).path),
    );
    if (!this.logId || !this.entries.has(this.logId))
      this.logId = this.logRepositories[0]?.id;
    if (this.commitId && !this.entries.has(this.commitId))
      this.commitId = undefined;
    await this.follow(vscode.window.activeTextEditor?.document.uri);
    this.publish();
  }
  private async created(uri: vscode.Uri) {
    if (uri.scheme !== "file" || this.disposed) return;
    const kind = path.basename(uri.fsPath) === ".git" ? "git" : "cvs";
    const directory =
      kind === "git"
        ? path.dirname(uri.fsPath)
        : path.dirname(path.dirname(uri.fsPath));
    const root = await fs.realpath(directory).catch(() => directory);
    // 已登记的根和已有 CVS 目录下新建的子目录不触发整区发现。
    if (
      [...this.entries.values()].some(
        (entry) => entry.info.kind === kind && entry.info.root === root,
      ) ||
      (kind === "cvs" &&
        (await fs.lstat(path.join(path.dirname(root), "CVS")).then(
          () => true,
          () => false,
        )))
    )
      return;
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.discoveryTimer = setTimeout(() => {
      this.discoveryTimer = undefined;
      void this.scan();
    }, 500);
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
      snapshot: { repositoryId: id, files: [], refreshing: kind === "git" },
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
      entry.cvs = new CvsSession(
        id,
        root,
        guard,
        (snapshot) => {
          if (this.entries.get(id) !== entry || !this.listed(entry)) return;
          entry.snapshot = { ...snapshot, branch: entry.snapshot.branch };
          this.publishSnapshot(entry.snapshot);
        },
        this.cvsCache,
      );
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(root, "**/*"),
      );
      for (const subscribe of [
        watcher.onDidChange,
        watcher.onDidCreate,
        watcher.onDidDelete,
      ])
        entry.disposables.push(
          subscribe(() => {
            if (this.listed(entry)) this.schedule(entry);
          }),
        );
      entry.disposables.push(watcher);
    }
    // 首仓可用即选中，不能让日志等待整个工作区的发现遍历结束。
    this.logId ??= id;
    this.publish();
    void this.refresh(entry, false);
    return id;
  }
  private remove(id: string) {
    for (const streams of this.streams.values()) streams.delete(id);
    const entry = this.entries.get(id);
    if (!entry) return;
    entry.git?.dispose();
    entry.cvs?.dispose();
    for (const disposable of entry.disposables) disposable.dispose();
    this.entries.delete(id);
    this.publishedSnapshots.delete(id);
    for (const [key, uri] of this.revisionUris)
      if (uri.authority === id) this.revisionUris.delete(key);
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }
  private written(entry: Entry) {
    entry.cvs?.markLogStale();
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
    // CVS 已有串行本地／网络队列，不能让网络等待占用 Git 本地槽位。
    if (entry.cvs) return this.refreshNow(entry, network, paths);
    if (entry.refreshTask && !network && !paths?.length)
      return entry.refreshTask;
    const run = async () => {
      if (this.localActive >= 4)
        await new Promise<void>((resolve) => this.localWaiters.push(resolve));
      else this.localActive++;
      try {
        await this.refreshNow(entry, network, paths);
      } finally {
        const next = this.localWaiters.shift();
        if (next) next();
        else this.localActive--;
      }
    };
    const task = run();
    entry.refreshTask = task;
    try {
      await task;
    } finally {
      if (entry.refreshTask === task) entry.refreshTask = undefined;
    }
  }
  private async refreshNow(entry: Entry, network: boolean, paths?: string[]) {
    if (
      this.disposed ||
      this.entries.get(entry.info.id) !== entry ||
      entry.scanStopped ||
      !this.listed(entry)
    )
      return;
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
      entry.snapshot = {
        repositoryId: entry.info.id,
        files: changes,
        branch: (await git.service.getCurrentBranch()) ?? undefined,
        merging: (await git.service.mergeInProgress()) || undefined,
      };
    } catch (error) {
      if (isScanLimit(error)) {
        entry.scanStopped = true;
        entry.snapshot = {
          ...entry.snapshot,
          error: undefined,
          refreshing: false,
          scanPaused: true,
        };
      } else
        entry.snapshot = {
          ...entry.snapshot,
          scanPaused: undefined,
          refreshing: false,
          error: localizeError(
            error instanceof Error ? error : "Repository refresh failed.",
          ),
        };
    }
    this.publishSnapshot(entry.snapshot);
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
      this.historyRequest = undefined;
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
      await Promise.all(
        [...this.entries.values()]
          .filter((entry) => entry.git && within(entry.info.root, uri.fsPath))
          .map((entry) => entry.git?.saved(uri)),
      );
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
    this.streams.set(view, new Map());
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
        if (this.views.has(view)) {
          const initial =
            msg.command === "getRepositories" ||
            msg.command === "getRepositoryChanges";
          const workspace = data as ReturnType<RepositoryManager["state"]>;
          await view.postMessage({
            type: "response",
            id: msg.id,
            success: true,
            data: initial ? this.summaryState(workspace) : data,
          });
          if (initial)
            for (const snapshot of workspace.snapshots) {
              const entry = this.entries.get(snapshot.repositoryId);
              if (entry && this.listed(entry))
                void this.streamSnapshot(view, entry.snapshot);
            }
        }
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
        this.streams.delete(view);
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
    if (command === "collapseLocalChanges") {
      const commands = await vscode.commands.getCommands(true);
      return vscode.commands.executeCommand(
        commands.includes("core.toggle.left.panel")
          ? "core.toggle.left.panel"
          : "workbench.action.closeSidebar",
      );
    }
    if (command === "getFileIcons") {
      const files = this.paths(values.filePaths);
      if (files.length > 128) throw new Error(vscode.l10n.t("Select files."));
      return getFileIcons(files);
    }
    if (command === "getRepositories") return this.state();
    if (command === "scanRepository") {
      const entry = this.selected(repositoryId);
      await this.guard(entry);
      entry.scanStopped = false;
      if (entry.cvs) await entry.cvs.resumeScan();
      else await this.refresh(entry, false);
      return this.metadata();
    }
    if (command === "removeSynchronizedRepository") {
      const entry = this.selected(repositoryId);
      await this.guard(entry);
      if (entry.info.kind !== "cvs")
        throw new Error(vscode.l10n.t("Select a CVS repository root."));
      const { root } = entry.info;
      this.remove(entry.info.id);
      this.add("cvs", root);
      if (this.commitId === entry.info.id) this.commitId = undefined;
      this.historyRequest = undefined;
      this.publish();
      return this.metadata();
    }
    if (command === "selectRepository") {
      const entry = this.selected(repositoryId, values.surface !== "commit");
      await this.guard(entry);
      if (values.surface === "commit") this.commitId = entry.info.id;
      else this.logId = entry.info.id;
      this.publish();
      return this.metadata();
    }
    if (command === "getRepositoryChanges") return this.state();
    if (command === "refreshRepositories") {
      for (const entry of this.entries.values())
        await this.refresh(entry, true);
      return this.metadata();
    }
    if (command === "commitRepositories")
      return this.commit(values, repositoryId as string | undefined);
    const entry = this.selected(
      repositoryId ?? (command === "updateProject" ? this.commitId : undefined),
      LOG_COMMANDS.has(command),
    );
    await this.guard(entry);
    if (command === "updateProject") {
      try {
        if (entry.git) {
          const diverged = await entry.git.update();
          if (diverged) void this.divergedNotice(entry, diverged);
        } else {
          const conflicts = await this.cvs(entry).update();
          if (conflicts.length)
            void this.conflictNotice(entry, conflicts.length);
        }
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
      await this.refresh(entry, false);
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
    if (command === "getWorkingFilePreview") {
      const file = repositoryPath(values.filePath);
      if (
        !entry.snapshot.files.some(
          (item) => item.path === file && !item.directory,
        )
      )
        throw new Error(
          vscode.l10n.t(
            "The requested working-tree change is no longer available",
          ),
        );
      if (!entry.git) return this.cvs(entry).preview(file);
    }
    if (entry.git) return entry.git.router.request(command, values);
    const cvs = this.cvs(entry);
    if (command === "getCvsHistory")
      return cvs.history(
        repositoryPath(values.filePath),
        values.refresh === true,
      );
    if (command === "diffCvsRevision")
      return cvs.revisionDiff(
        repositoryPath(values.filePath),
        String(values.revision),
      );
    if (command === "compareCvsWorkingFile")
      return cvs.compareWithWorking(
        repositoryPath(values.filePath),
        String(values.revision),
      );
    if (command === "getCvsLog")
      return cvs.repositoryLog(values.days as number, {
        refresh: values.refresh === true,
        cached: values.cached === true,
      });
    if (command === "getCvsCommit")
      return cvs.commitFiles(values.commitId as string);
    if (command === "getCvsFiles")
      return cvs.scanAvailable ? cvs.fileNames() : [];
    if (command === "showDiffForWorkingFile")
      return cvs.diff(repositoryPath(values.filePath));
    if (command === "rollbackFiles" || command === "openRollbackPanel") {
      const files =
        command === "openRollbackPanel"
          ? (values.files as Array<{ path: string }>).map((file) => file.path)
          : this.paths(values.filePaths);
      // 确认后即返回：上万个文件的回滚在可取消的通知进度里执行，面板请求不等它完成。
      const rollback = await cvs.rollback(files);
      if (rollback)
        void (async () => {
          try {
            await rollback.done;
          } catch (error) {
            void vscode.window.showErrorMessage(localizeError(error));
          } finally {
            await this.refresh(entry, true);
            this.written(entry);
          }
        })();
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
  // 更新产生冲突：一条通知写明数量，点开在本地更改定位到该仓的合并冲突分组。
  private async conflictNotice(entry: Entry, count: number) {
    const show = vscode.l10n.t("Show Conflicts");
    const choice = await vscode.window.showWarningMessage(
      vscode.l10n.t("Update Project: {0} file(s) have merge conflicts.", count),
      show,
    );
    if (choice !== show || this.entries.get(entry.info.id) !== entry) return;
    this.commitId = entry.info.id;
    this.publish();
    await vscode.commands.executeCommand("jettortoise.commitPanel.focus");
    this.broadcast("revealConflicts", { repositoryId: entry.info.id });
  }
  /** 分叉无法快进：说明两侧提交数，用户选择合并或变基后直接执行。 */
  private async divergedNotice(entry: Entry, diverged: DivergedUpstream) {
    const merge = vscode.l10n.t("Merge");
    const rebase = vscode.l10n.t("Rebase");
    const choice = await vscode.window.showWarningMessage(
      divergedMessage(diverged),
      merge,
      rebase,
    );
    const git = entry.git;
    if (!choice || !git || this.entries.get(entry.info.id) !== entry) return;
    try {
      await this.guard(entry);
      const conflicts = await git.integrate(
        choice === merge ? "merge" : "rebase",
      );
      if (conflicts) void this.conflictNotice(entry, conflicts);
    } catch (error) {
      void vscode.window.showErrorMessage(localizeError(error));
    } finally {
      await this.refresh(entry, true);
      this.written(entry);
    }
  }
  private paths(value: unknown) {
    if (!Array.isArray(value) || !value.length)
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
  private async commit(values: Record<string, unknown>, repositoryId?: string) {
    if (
      typeof values.message !== "string" ||
      values.message.length > 16000 ||
      values.message.includes("\0")
    )
      throw new Error(vscode.l10n.t("Enter a commit message."));
    const selected = values.files as Array<{
      repositoryId: string;
      path: string;
    }>;
    const grouped = new Map<Entry, Map<string, ChangeFile>>();
    // 合并进行中且解决结果与本地相同：没有可选文件，只提交该仓的合并。
    if (Array.isArray(selected) && !selected.length && repositoryId)
      grouped.set(this.selected(repositoryId), new Map());
    for (const file of selected) {
      const entry = this.selected(file.repositoryId);
      const name = repositoryPath(file.path);
      const group = grouped.get(entry) ?? new Map<string, ChangeFile>();
      if (!group.has(name))
        group.set(name, {
          repositoryId: entry.info.id,
          path: name,
          status: "modified",
          staged: false,
        });
      grouped.set(entry, group);
    }
    if (!grouped.size) throw new Error(vscode.l10n.t("Select changed files."));
    // 所有仓库先验证；实际提交仍逐仓独立，失败保留已成功仓库回执。
    for (const [entry, files] of grouped) {
      await this.guard(entry);
      await this.refresh(entry, false);
      if (entry.snapshot.error) throw new Error(entry.snapshot.error);
      if (!files.size && !(entry.git && entry.snapshot.merging))
        throw new Error(vscode.l10n.t("Select changed files."));
      const current = new Map(
        entry.snapshot.files.map((change) => [change.path, change]),
      );
      for (const file of files.values()) {
        const change = current.get(file.path);
        if (!change || !canCommit(change))
          throw new Error(
            vscode.l10n.t(
              "{0}: selected file cannot be committed: {1}",
              entry.info.name,
              file.path,
            ),
          );
        Object.assign(file, change);
      }
      // 所选文件的子仓边界一次查完；目录不会出现在可提交更改里。
      const boundaries = await boundariesForPaths(
        entry.info.root,
        entry.info.kind,
        [...files.keys()],
      );
      if (boundaries.length)
        throw new NestedRepositoryError(
          boundaries,
          "NESTED_REPOSITORY",
          entry.info.root,
        );
    }
    // 空说明只用于 Git 合并类操作的默认说明，由 Git 会话再核对进行中状态。
    if (
      !values.message.trim() &&
      [...grouped.keys()].some((entry) => !entry.git)
    )
      throw new Error(vscode.l10n.t("Enter a commit message."));
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
            [...files.values()].flatMap((file) =>
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
    // CVS 修订内容只在本会话显式差异签发后可读，未同步仓的历史差异同样适用。
    const entry = this.selected(
      uri.authority,
      this.entries.get(uri.authority)?.info.kind === "cvs",
    );
    await this.guard(entry);
    const content = await (entry.git
      ? entry.git.readFile(uri)
      : this.cvs(entry).readFile(uri));
    this.revisionUris.set(uri.toString(), uri);
    return revisionContent(
      uri,
      vscode.Uri.file(path.join(entry.info.root, uri.path.slice(1))),
      content,
    );
  }
  /** 清除全部 CVS 日志缓存（日志、单文件历史、修订内容）；下次打开日志整段重取。 */
  async clearCvsCache() {
    await this.cvsCache?.clear();
    for (const entry of this.entries.values()) entry.cvs?.resetCache();
    void vscode.window.showInformationMessage(
      vscode.l10n.t("CVS log cache cleared."),
    );
  }
  async execute(command: string, ...args: unknown[]) {
    if (command === "jettortoise.clearCvsLogCache") return this.clearCvsCache();
    if (command === "jettortoise.synchronizeRepository") {
      const uri = args[0] as vscode.Uri | undefined;
      const entry =
        uri?.scheme === "file"
          ? [...this.entries.values()].find(
              (item) =>
                item.info.kind === "cvs" && item.info.root === uri.fsPath,
            )
          : undefined;
      if (!entry || !(await isCvsSyncRoot(entry.info.root)))
        throw new Error(vscode.l10n.t("Select a CVS repository root."));
      await this.guard(entry);
      const tag = await readRepositoryReference("cvs", entry.info.root);
      entry.snapshot.branch =
        tag && /^[TN]/.test(tag) ? tag.slice(1) : undefined;
      entry.info = { ...entry.info, syncedAt: Date.now() };
      this.commitId = this.logId = entry.info.id;
      this.historyRequest = undefined;
      this.editorOwnerId = undefined;
      this.activeFile = undefined;
      this.publish();
      await vscode.commands.executeCommand("jettortoise.commitPanel.focus");
      await vscode.commands.executeCommand("jettortoise.gitLog.focus");
      await this.refresh(entry, true);
      return;
    }
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
      const history =
        command === "jettortoise.openHistory" ||
        command === "jettortoise.showFileHistory";
      const entry = uri
        ? await this.owner(uri)
        : this.selected(history ? undefined : this.commitId, history);
      if (!entry || (!history && !this.listed(entry)))
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
      this.historyRequest = {
        repositoryId: entry.info.id,
        sequence: ++this.historySequence,
      };
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
    if (this.publishTimer) clearTimeout(this.publishTimer);
    if (this.discoveryTimer) clearTimeout(this.discoveryTimer);
    this.streams.clear();
    this.scanController?.abort();
    for (const id of this.entries.keys()) this.remove(id);
    for (const item of this.disposables) item.dispose();
    this.views.clear();
    this.revisionChanges.dispose();
    this.revisionUris.clear();
  }
}
