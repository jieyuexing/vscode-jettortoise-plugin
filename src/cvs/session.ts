import * as fs from "node:fs/promises";
import * as path from "node:path";
import { assertOwnedPath } from "tortoise-core/boundaries";
import * as vscode from "vscode";
import { CvsComparisonResolver } from "../comparison/resolver";
import { isScanLimit, localizeError } from "../messages/errors";
import type { ChangeFile, RepositorySnapshot } from "../repositories/changes";
import { hasDirtyEditors } from "../repositories/editor-documents";

interface CvsFile {
  newPath: string;
  entryRevision: string;
  state: string;
  status?: string;
  mtimeMs?: number;
}
export interface CvsRevision {
  revisionId: string;
  timestamp: string;
  author: { name: string };
  subject: string;
  body: string;
  state?: string;
}
interface LogRevision {
  path: string;
  revision: string;
  time: number;
  author: string;
  state: string;
  commitId?: string;
  message: string;
}
export interface CvsLogFile {
  path: string;
  revision: string;
  previous?: string;
  kind: "added" | "modified" | "deleted";
  /** 本地工作副本里有这个文件；没有时界面标“本地没有”，提示先更新（含 update -d）。 */
  local?: boolean;
}
interface LogCommit {
  id: string;
  time: number;
  author: string;
  message: string;
  files: CvsLogFile[];
}
/** 日志列表一行；文件另经 commitFiles 取，列表不带文件。 */
export interface CvsLogCommit {
  id: string;
  time: number;
  author: string;
  subject: string;
  body: string;
  fileCount: number;
}
interface Adapter {
  localStatus(names?: string[]): Promise<CvsFile[]>;
  entryNames(): Promise<string[]>;
  status(signal?: AbortSignal, local?: CvsFile[]): Promise<CvsFile[]>;
  file(name: string): Promise<CvsFile>;
  log(name: string, signal?: AbortSignal): Promise<CvsRevision[]>;
  repositoryLog(
    range: { from?: number; to?: number },
    signal?: AbortSignal,
  ): Promise<LogRevision[]>;
  content(
    name: string,
    revision: string,
    signal?: AbortSignal,
    options?: {
      maxBytes?: number;
      revisions?: () => Promise<CvsRevision[]>;
    },
  ): Promise<Buffer>;
  identity(): Promise<{
    root: string;
    repository: string;
    tag: string;
    branch: string;
    workingCopy: string;
  }>;
  localFiles(names: string[]): Promise<Set<string>>;
  contentCache?: {
    read(name: string, revision: string): Promise<Buffer | undefined>;
    write(name: string, revision: string, bytes: Buffer): Promise<void>;
  };
  commit(names: string[], message: string, signal?: AbortSignal): Promise<void>;
  rollback(
    names: string[],
    signal?: AbortSignal,
    progress?: (done: number, total: number) => void,
  ): Promise<string[]>;
  add(names: string[], signal?: AbortSignal): Promise<void>;
  update(signal?: AbortSignal): Promise<string[]>;
}
interface Process {
  readonly executable?: string;
  run(
    args: string[],
    cwd: string,
    signal?: AbortSignal,
    allowed?: number[],
    options?: object,
  ): Promise<unknown>;
}
interface Queue {
  run<T>(job: (signal: AbortSignal) => Promise<T>): Promise<T>;
  cancel(): void;
}
const core = require("tortoise-core/cvs") as {
  CvsProcess: new (executable?: string) => Process;
  CvsAdapter: new (root: string, process: Process) => Adapter;
  SerialQueue: new () => Queue;
};
const commits = require("tortoise-core/cvs/log") as {
  groupCommits(revisions: LogRevision[]): LogCommit[];
  mergeRevisions(a: LogRevision[], b: LogRevision[]): LogRevision[];
  previousRevision(revision: string): string | undefined;
  compareRevisions(a: string, b: string): number;
  logDate(time: number): string;
};
const logSession = require("tortoise-core/cvs/log-session") as {
  loadRepositoryLog(input: {
    state?: LogState;
    days: number;
    refresh?: boolean;
    stale?: boolean;
    fetchRevisions(
      range: { from?: number; to?: number },
      signal?: AbortSignal,
    ): Promise<LogRevision[]>;
    readLog(): Promise<LogState | undefined>;
    writeLog(state: LogState): Promise<void>;
    signal?: AbortSignal;
  }): Promise<{
    state: LogState;
    contacted: boolean;
    refreshed: boolean;
    error?: unknown;
  }>;
  rangeStart(days: number, now: number): number;
};
const cacheModule = require("tortoise-core/cvs/cache") as {
  CvsCacheStore: new (
    directory: string,
  ) => CvsCacheStore & {
    clear(): Promise<void>;
  };
};
/** 落盘缓存（目录由调用方给出，只在扩展存储目录里）。 */
export function createCvsCacheStore(directory: string) {
  return new cacheModule.CvsCacheStore(directory);
}
/** 仓库日志缓存：已覆盖的起点（0 为全部历史）、最新修订时间、最近一次连服务器的时间与修订。 */
interface LogState {
  coveredFrom: number;
  newest: number | null;
  fetchedAt: number;
  revisions: LogRevision[];
}
interface HistoryEntry {
  entryRevision: string;
  fetchedAt: number;
  revisions: CvsRevision[];
}
interface RepositoryCache {
  readLog(): Promise<LogState | undefined>;
  writeLog(state: LogState): Promise<void>;
  readHistories(): Promise<Record<string, HistoryEntry>>;
  writeHistories(files: Record<string, HistoryEntry>): Promise<void>;
  readContent(file: string, revision: string): Promise<Buffer | undefined>;
  writeContent(file: string, revision: string, bytes: Buffer): Promise<void>;
}
export interface CvsCacheStore {
  repository(identity: {
    root: string;
    repository: string;
    branch: string;
    workingCopy: string;
  }): RepositoryCache;
}

export class CvsSession {
  private readonly queue = new core.SerialQueue();
  private readonly issuedRevisions = new Set<string>();
  private readonly adapter: Adapter;
  private files: CvsFile[] = [];
  // 仓库日志与单文件历史的内存副本，来自落盘缓存；key 随 CVSROOT、模块与粘性标签变化。
  private logState?: LogState;
  private histories?: Record<string, HistoryEntry>;
  private cacheKey = "";
  // 提交、更新等写入之后：缓存保留，下次打开或刷新走增量。
  private logStale = false;
  private logFiles = new Map<string, CvsLogFile[]>();
  private localTail: Promise<void> = Promise.resolve();
  private network: Promise<void> | undefined;
  private disposed = false;
  private scanStopped = false;
  private error: string | undefined;
  constructor(
    readonly id: string,
    readonly root: string,
    private readonly guard: () => Promise<void>,
    private readonly publish: (snapshot: RepositorySnapshot) => void,
    private readonly store?: CvsCacheStore,
  ) {
    const process = new core.CvsProcess(
      vscode.workspace
        .getConfiguration("jettortoise")
        .get<string>("cvsPath", "cvs"),
    );
    this.adapter = new core.CvsAdapter(root, {
      executable: process.executable,
      run: async (...args) => {
        await guard();
        if (this.disposed)
          throw new Error(vscode.l10n.t("Repository removed."));
        return process.run(args[0], args[1], args[2], args[3], {
          ...args[4],
          beforeStart: async () => {
            await guard();
            if (this.disposed)
              throw new Error(vscode.l10n.t("Repository removed."));
          },
        });
      },
    });
    // 修订内容落盘缓存：修订不可变，命中即不再向服务器读取。
    this.adapter.contentCache = {
      read: async (file, revision) =>
        (await this.context().catch(() => undefined))?.cache?.readContent(
          file,
          revision,
        ),
      write: async (file, revision, bytes) => {
        await (await this.context().catch(() => undefined))?.cache
          ?.writeContent(file, revision, bytes)
          .catch(() => {});
      },
    };
  }
  /** 仓库标识（CVSROOT、模块、标签）与落盘缓存；没有扩展存储或读不到 CVS 元数据时没有落盘缓存。 */
  private async context() {
    const id = await this.adapter.identity();
    const key = JSON.stringify([id.root, id.repository, id.tag]);
    if (key !== this.cacheKey) {
      this.cacheKey = key;
      this.logState = undefined;
      this.histories = undefined;
    }
    return {
      id,
      cache: this.store?.repository({
        root: id.root,
        repository: id.repository,
        branch: id.tag,
        workingCopy: id.workingCopy,
      }),
    };
  }
  private changes(files: CvsFile[]): ChangeFile[] {
    return files
      .filter((file) => file.state !== "Up-to-date")
      .map((file) => ({
        repositoryId: this.id,
        path: file.newPath.replace(/\/$/, ""),
        staged: false,
        directory: file.newPath.endsWith("/"),
        status: ["Needs Checkout", "Needs Patch"].includes(file.state)
          ? "incoming"
          : ["Needs Merge", "File had conflicts on merge"].includes(file.state)
            ? "conflicted"
            : file.state === "Unknown"
              ? "untracked"
              : file.status === "added"
                ? "added"
                : file.status === "deleted"
                  ? "deleted"
                  : "modified",
      }));
  }
  private emit(refreshing = false) {
    if (!this.disposed)
      this.publish({
        repositoryId: this.id,
        files: this.changes(this.files),
        error: this.error,
        refreshing,
        scanPaused: this.scanStopped || undefined,
      });
  }
  get scanAvailable() {
    return !this.scanStopped;
  }
  async resumeScan() {
    this.scanStopped = false;
    await this.refresh();
  }
  // 只读 Entries，不盘点工作区、不改本地快照，未同步仓也可用；目录数超限时返回空清单。
  async fileNames(): Promise<string[]> {
    await this.guard();
    try {
      return await this.adapter.entryNames();
    } catch (error) {
      if (isScanLimit(error)) return [];
      throw new Error(cvsErrorText(error));
    }
  }
  async refresh(paths?: string[], network = false): Promise<void> {
    const job = async () => {
      if (this.scanStopped || this.disposed) return;
      await this.guard();
      const previous = new Map(this.files.map((file) => [file.newPath, file]));
      const local = (await this.adapter.localStatus(paths)).map((file) => {
        const known = previous.get(file.newPath);
        // 网络已确认内容未改时，焦点刷新不再仅因 Entries 时间戳不符报 M。
        return file.state === "Locally Modified" &&
          known?.state === "Up-to-date" &&
          known.entryRevision === file.entryRevision &&
          known.mtimeMs === file.mtimeMs
          ? known
          : file;
      });
      await this.guard();
      if (paths) {
        const changed = new Set(paths);
        this.files = [
          ...this.files.filter((file) => !changed.has(file.newPath)),
          ...local,
        ];
      } else this.files = local;
      this.error = undefined;
      this.emit(!!this.network);
    };
    const next = this.localTail.then(job, job);
    this.localTail = next.catch((error) => {
      this.refreshError(error);
      this.emit();
    });
    await this.localTail;
    if (network && !this.network && !this.disposed && !this.scanStopped) {
      this.network = this.queue
        .run(async (signal) => {
          await this.guard();
          const before = await this.adapter.localStatus();
          const mtimes = new Map(
            before.map((file) => [file.newPath, file.mtimeMs]),
          );
          const result = await this.adapter.status(signal, before);
          await this.localTail;
          await this.guard();
          const current = await this.adapter.localStatus();
          // 网络结果为准；只有网络开始后 mtime 变化的文件才采用本地状态。
          const changed = current.filter(
            (file) =>
              !mtimes.has(file.newPath) ||
              mtimes.get(file.newPath) !== file.mtimeMs,
          );
          const changedPaths = new Set(changed.map((file) => file.newPath));
          this.files = [
            ...result.filter((file) => !changedPaths.has(file.newPath)),
            ...changed,
          ];
          this.error = undefined;
        })
        .catch((error) => {
          this.refreshError(error);
        })
        .finally(() => {
          this.network = undefined;
          this.emit();
        });
      this.emit(true);
    }
  }
  private refreshError(error: unknown) {
    if (isScanLimit(error)) {
      this.scanStopped = true;
      this.error = undefined;
    } else this.error = cvsErrorText(error);
  }
  async operate<T>(
    label: string,
    action: (
      adapter: Adapter,
      signal: AbortSignal,
      progress: vscode.Progress<{ message?: string }>,
    ) => Promise<T>,
    dirty = false,
    // 只读查询把进度放状态栏，写操作保留可取消的通知。
    location = vscode.ProgressLocation.Notification,
  ): Promise<T> {
    try {
      return await this.queue.run(async (signal) => {
        await this.guard();
        if (this.disposed)
          throw new Error(vscode.l10n.t("Repository removed."));
        if (dirty && (await hasDirtyEditors(this.root)))
          throw new Error(
            vscode.l10n.t("Save unsaved editors before modifying files."),
          );
        return vscode.window.withProgress(
          {
            location,
            title: `JetTortoise: ${label}`,
            cancellable: true,
          },
          async (progress, token) => {
            const cancel = token.onCancellationRequested(() =>
              this.queue.cancel(),
            );
            try {
              return await action(this.adapter, signal, progress);
            } finally {
              cancel.dispose();
            }
          },
        );
      });
    } catch (error) {
      throw new Error(cvsErrorText(error));
    }
  }
  commit(paths: string[], message: string) {
    return this.operate(
      vscode.l10n.t("CVS Commit"),
      (adapter, signal) => adapter.commit(paths, message, signal),
      true,
    );
  }
  add(paths: string[]) {
    return this.operate(
      vscode.l10n.t("CVS Add"),
      (adapter, signal) => adapter.add(paths, signal),
      true,
    );
  }
  update() {
    return this.operate(
      vscode.l10n.t("Update Project"),
      (adapter, signal) => adapter.update(signal),
      true,
    );
  }
  history(file: string, refresh = false) {
    return this.operate(
      vscode.l10n.t("CVS File History"),
      (adapter, signal) => this.fileHistory(adapter, signal, file, refresh),
      false,
      vscode.ProgressLocation.Window,
    );
  }
  /**
   * 单文件历史：仓库缓存已覆盖全部历史（没有粘性分支）时直接由它给出；否则用按文件缓存的结果，
   * 以本地 Entries 里的修订号为准（修订号变了就重取）；都没有、或 refresh 时取一次并缓存。
   */
  private async fileHistory(
    adapter: Adapter,
    signal: AbortSignal,
    file: string,
    refresh: boolean,
  ): Promise<CvsRevision[]> {
    const context = await this.context();
    await this.loadCache(context.cache);
    const entry = await adapter.file(file).then(
      (item) => item.entryRevision.replace(/^-/, ""),
      () => "",
    );
    if (!refresh) {
      const own = (
        this.logState?.coveredFrom === 0 && !context.id.branch
          ? this.logState.revisions.filter((item) => item.path === file)
          : []
      ).sort((a, b) => commits.compareRevisions(b.revision, a.revision));
      if (own.length && (!entry || own.some((item) => item.revision === entry)))
        return own.map((item) => ({
          revisionId: item.revision,
          timestamp: commits.logDate(item.time),
          author: { name: item.author },
          subject: item.message.split("\n")[0] || "(empty)",
          body: item.message.split("\n").slice(1).join("\n"),
          state: item.state,
        }));
      const cached = this.histories?.[file];
      if (cached && cached.entryRevision === entry) return cached.revisions;
    }
    const revisions = await adapter.log(file, signal);
    this.histories = {
      ...this.histories,
      [file]: { entryRevision: entry, fetchedAt: Date.now(), revisions },
    };
    await context.cache?.writeHistories(this.histories).catch(() => {});
    return revisions;
  }
  /**
   * 仓库级提交列表（近 days 天，0 为全部），缓存落盘：
   * - cached：只读缓存，不连服务器（打开日志时先显示它）；
   * - 否则缓存已覆盖该范围且距上次连服务器不到 LOG_FRESH_MS 时不连服务器；
   * - 更大的范围只取缺的那一段；过了新鲜期或 refresh 时从最新缓存时间往回 LOG_OVERLAP_MS 取增量，
   *   按 path@revision 合并去重。写入（提交、更新）只标记过期，缓存不作废。
   */
  async repositoryLog(
    days: number,
    options: { refresh?: boolean; cached?: boolean } = {},
  ) {
    if (options.cached) {
      await this.guard();
      const context = await this.context();
      await this.loadCache(context.cache);
      return this.logResult(days, true);
    }
    return this.operate(
      vscode.l10n.t("CVS Repository Log"),
      async (adapter, signal) => {
        const context = await this.context();
        await this.loadCache(context.cache);
        const result = await logSession.loadRepositoryLog({
          state: this.logState,
          days,
          refresh: options.refresh,
          stale: this.logStale,
          fetchRevisions: (range, abort) => adapter.repositoryLog(range, abort),
          readLog: () => context.cache?.readLog() ?? Promise.resolve(undefined),
          writeLog: (next) =>
            context.cache?.writeLog(next) ?? Promise.resolve(),
          signal,
        });
        this.logState = result.state;
        if (result.refreshed) this.logStale = false;
        const error = result.error ? cvsErrorText(result.error) : undefined;
        return this.logResult(days, !result.contacted, error);
      },
      false,
      vscode.ProgressLocation.Window,
    );
  }
  private async loadCache(cache?: RepositoryCache) {
    if (!this.logState && cache) this.logState = await cache.readLog();
    if (!this.histories) this.histories = (await cache?.readHistories()) ?? {};
  }
  private logResult(days: number, fromCache: boolean, error?: string) {
    const state = this.logState;
    const since = logSession.rangeStart(days, Date.now());
    const grouped = commits.groupCommits(
      (state?.revisions ?? []).filter((item) => item.time >= since),
    );
    this.logFiles = new Map(grouped.map((item) => [item.id, item.files]));
    return {
      days,
      cachedAt: state?.fetchedAt,
      fromCache,
      error,
      commits: grouped.map(
        (item): CvsLogCommit => ({
          id: item.id,
          time: item.time,
          author: item.author,
          subject: item.message.split("\n")[0] || "(empty)",
          body: item.message.split("\n").slice(1).join("\n"),
          fileCount: item.files.length,
        }),
      ),
    };
  }
  /** 日志列表里某个提交的文件，取自最近一次列表；标出本地工作副本里没有的文件，不连服务器。 */
  async commitFiles(commitId: string): Promise<CvsLogFile[]> {
    const files = this.logFiles.get(commitId);
    if (!files) throw new Error(vscode.l10n.t("Unknown commit."));
    const present = await this.adapter.localFiles(
      files.filter((file) => file.kind !== "deleted").map((file) => file.path),
    );
    return files.map((file) => ({
      ...file,
      local: file.kind === "deleted" || present.has(file.path),
    }));
  }
  /** 写入（提交、更新、回滚）之后：缓存保留，下次打开或刷新才走增量。 */
  markLogStale() {
    this.logStale = true;
  }
  /** 丢弃内存里的缓存（落盘缓存由调用方清除）。 */
  resetCache() {
    this.logState = undefined;
    this.histories = undefined;
    this.cacheKey = "";
    this.logFiles.clear();
  }
  /** 先确认，再在可取消的通知进度里排队执行；返回的 done 在完成时结束，调用方不必等待。 */
  async rollback(paths: string[]) {
    const confirmed = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Rollback {0} CVS file(s)? Local changes are replaced with the repository copy and kept as .#<file>.<revision> in the same directory; files with a newer repository revision are updated to it.",
        paths.length,
      ),
      { modal: true },
      vscode.l10n.t("Rollback"),
    );
    if (confirmed !== vscode.l10n.t("Rollback")) return undefined;
    const done = this.operate(
      vscode.l10n.t("CVS Rollback"),
      async (adapter, signal, progress) => {
        const backups = await adapter.rollback(paths, signal, (count, total) =>
          progress.report({
            message: vscode.l10n.t("{0} / {1} files", count, total),
          }),
        );
        // 备份名最多列三个，其余只写数量，避免上万个文件时通知过长。
        void vscode.window.showInformationMessage(
          backups.length > 3
            ? vscode.l10n.t(
                "CVS rollback completed. Backups: {0} and {1} more",
                backups.slice(0, 3).join(", "),
                backups.length - 3,
              )
            : vscode.l10n.t(
                "CVS rollback completed. Backups: {0}",
                backups.join(", "),
              ),
        );
      },
      true,
    );
    return { done };
  }
  private uri(file: string, revision: string) {
    const uri = vscode.Uri.from({
      scheme: "jettortoise",
      authority: this.id,
      path: `/${file}`,
      query: new URLSearchParams({ ref: revision }).toString(),
    });
    this.issuedRevisions.add(uri.toString());
    return uri;
  }
  async preview(file: string) {
    return this.operate(
      vscode.l10n.t("CVS revision"),
      async (adapter, signal) => {
        const resolver = new CvsComparisonResolver(adapter, this.root);
        const comparison = await resolver.working(file);
        const result = await resolver.materialize(comparison, signal);
        await this.guard();
        return result;
      },
      false,
      vscode.ProgressLocation.Window,
    );
  }
  async diff(file: string) {
    await this.guard();
    const entry = await this.adapter.file(file);
    const left = this.uri(file, "BASE");
    const right =
      entry.state === "Locally Removed" || entry.state === "Missing"
        ? this.uri(file, "empty")
        : vscode.Uri.file(path.join(this.root, file));
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      vscode.l10n.t("{0} (BASE ↔ working tree)", file),
    );
  }
  async revisionDiff(file: string, revision: string) {
    const history = await this.history(file);
    if (!history.some((entry) => entry.revisionId === revision))
      throw new Error(vscode.l10n.t("Unknown revision."));
    const previous = commits.previousRevision(revision) ?? "empty";
    if (
      previous !== "empty" &&
      !history.some((entry) => entry.revisionId === previous)
    )
      throw new Error(vscode.l10n.t("Previous revision is unavailable."));
    await this.guard();
    await vscode.commands.executeCommand(
      "vscode.diff",
      this.uri(file, previous),
      this.uri(file, revision),
      `${file} (${previous} ↔ ${revision})`,
    );
  }
  /** 所选修订与本地工作副本里的同名文件比较；本地没有该文件时报错，提示先更新。 */
  async compareWithWorking(file: string, revision: string) {
    await this.guard();
    await assertOwnedPath(this.root, "cvs", file);
    const target = path.join(this.root, file);
    if (!(await fs.stat(target).catch(() => undefined))?.isFile())
      throw new Error(
        vscode.l10n.t("Not in the working copy. Update the project first."),
      );
    const history = await this.history(file);
    if (!history.some((entry) => entry.revisionId === revision))
      throw new Error(vscode.l10n.t("Unknown revision."));
    await this.guard();
    await vscode.commands.executeCommand(
      "vscode.diff",
      this.uri(file, revision),
      vscode.Uri.file(target),
      vscode.l10n.t("{0} ({1} ↔ working tree)", file, revision),
    );
  }
  async readFile(uri: vscode.Uri) {
    await this.guard();
    if (!this.issuedRevisions.has(uri.toString()))
      throw new Error(
        vscode.l10n.t(
          "Open the file diff or history again to load CVS revisions.",
        ),
      );
    if (uri.authority !== this.id)
      throw new Error(vscode.l10n.t("Repository mismatch."));
    const file = uri.path.slice(1);
    await assertOwnedPath(this.root, "cvs", file);
    // 已缓存的修订内容直接返回，不排队、不连服务器。
    const requested = new URLSearchParams(uri.query).get("ref") ?? "";
    if (/^\d+(?:\.\d+)+$/.test(requested)) {
      const hit = await this.adapter.contentCache?.read(file, requested);
      if (hit) return hit;
    }
    return this.operate(
      vscode.l10n.t("CVS revision"),
      async (adapter, signal) => {
        let revision = new URLSearchParams(uri.query).get("ref") ?? "";
        // 在写队列内读取当前 Entries，避免排队期间提交后仍读取旧 BASE。
        if (revision === "BASE") {
          const entry = await adapter.file(file);
          revision = entry.entryRevision.replace(/^-/, "");
          if (revision === "0") revision = "empty";
        }
        return revision === "empty"
          ? Buffer.alloc(0)
          : adapter.content(file, revision, signal, {
              // 缓存里没有该修订时才需要历史；找不到就重取一次（别人刚提交的新修订）。
              revisions: async () => {
                const known = await this.fileHistory(
                  adapter,
                  signal,
                  file,
                  false,
                );
                return known.some((item) => item.revisionId === revision)
                  ? known
                  : this.fileHistory(adapter, signal, file, true);
              },
            });
      },
    );
  }
  dispose() {
    this.disposed = true;
    this.queue.cancel();
  }
}
export function cvsErrorText(error: unknown): string {
  const code = (error as { code?: string })?.code;
  if (code === "NESTED_REPOSITORY" && error instanceof Error)
    return localizeError(error);
  const messages: Record<string, string> = {
    command: vscode.l10n.t(
      "CVS failed. Check repository access and working copy state, then refresh.",
    ),
    missingClient: vscode.l10n.t(
      "CVS was not found. Set JetTortoise: CVS Path to an installed client.",
    ),
    cancelled: vscode.l10n.t(
      "CVS cancelled. Refresh to check whether files were partly changed.",
    ),
    timeout: vscode.l10n.t("CVS timed out. Refresh before retrying."),
    outputLimit: vscode.l10n.t("CVS log is too large. Choose a shorter range."),
    commitState: vscode.l10n.t(
      "Selected files cannot be committed. Refresh and resolve conflicts first.",
    ),
    BOUNDARY_UNAVAILABLE: vscode.l10n.t(
      "Repository boundaries could not be fully verified.",
    ),
    path: vscode.l10n.t(
      "CVS path is invalid or exceeds the command length limit.",
    ),
    revision: vscode.l10n.t("CVS revision is invalid."),
    root: vscode.l10n.t("CVS repository root changed or is invalid."),
    module: vscode.l10n.t("CVS module is invalid."),
    workingCopy: vscode.l10n.t("No CVS working copy was found."),
    symlink: vscode.l10n.t(
      "CVS requires regular files and directories, without symbolic links.",
    ),
    inventoryLimit: vscode.l10n.t(
      "CVS working copy exceeds the inventory limit.",
    ),
    parse: vscode.l10n.t(
      "CVS output could not be parsed. Check the working copy and refresh.",
    ),
    changed: vscode.l10n.t(
      "CVS file changed during the operation. Refresh before retrying.",
    ),
    message: vscode.l10n.t("Enter a valid CVS commit message."),
  };
  return code
    ? (messages[code] ??
        vscode.l10n.t("CVS could not complete the operation ({0}).", code))
    : error instanceof Error
      ? localizeError(error)
      : vscode.l10n.t("CVS operation failed.");
}
