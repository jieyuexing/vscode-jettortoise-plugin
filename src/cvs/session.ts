import * as path from "node:path";
import * as vscode from "vscode";
import { CvsComparisonResolver } from "../comparison/resolver";
import { localizeError } from "../messages/errors";
import { assertOwnedPath } from "../repositories/boundaries.cjs";
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
}
interface Adapter {
  localStatus(names?: string[]): Promise<CvsFile[]>;
  status(signal?: AbortSignal, local?: CvsFile[]): Promise<CvsFile[]>;
  file(name: string): Promise<CvsFile>;
  log(name: string, signal?: AbortSignal): Promise<CvsRevision[]>;
  content(
    name: string,
    revision: string,
    signal?: AbortSignal,
    options?: { maxBytes?: number },
  ): Promise<Buffer>;
  commit(names: string[], message: string, signal?: AbortSignal): Promise<void>;
  rollback(name: string, signal?: AbortSignal): Promise<string>;
  add(names: string[], signal?: AbortSignal): Promise<void>;
  update(signal?: AbortSignal): Promise<void>;
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
const core = require("./core.mjs") as {
  CvsProcess: new (executable?: string) => Process;
  CvsAdapter: new (root: string, process: Process) => Adapter;
  SerialQueue: new () => Queue;
};

export class CvsSession {
  private readonly queue = new core.SerialQueue();
  private readonly adapter: Adapter;
  private files: CvsFile[] = [];
  private localTail: Promise<void> = Promise.resolve();
  private network: Promise<void> | undefined;
  private disposed = false;
  private error: string | undefined;
  constructor(
    readonly id: string,
    readonly root: string,
    private readonly guard: () => Promise<void>,
    private readonly publish: (snapshot: RepositorySnapshot) => void,
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
        return process.run(...args);
      },
    });
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
          : ["Needs Merge", "File had conflicts on merge", "Missing"].includes(
                file.state,
              )
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
      });
  }
  async refresh(paths?: string[], network = false): Promise<void> {
    const job = async () => {
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
      this.emit(!!this.network);
    };
    const next = this.localTail.then(job, job);
    this.localTail = next.catch((error) => {
      this.error = cvsErrorText(error);
      this.emit();
    });
    await this.localTail;
    if (network && !this.network && !this.disposed) {
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
          this.error = cvsErrorText(error);
        })
        .finally(() => {
          this.network = undefined;
          this.emit();
        });
      this.emit(true);
    }
  }
  async operate<T>(
    label: string,
    action: (adapter: Adapter, signal: AbortSignal) => Promise<T>,
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
          async (_progress, token) => {
            const cancel = token.onCancellationRequested(() =>
              this.queue.cancel(),
            );
            try {
              return await action(this.adapter, signal);
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
  history(file: string) {
    return this.operate(
      vscode.l10n.t("CVS File History"),
      (adapter, signal) => adapter.log(file, signal),
      false,
      vscode.ProgressLocation.Window,
    );
  }
  async rollback(paths: string[]) {
    return this.operate(
      vscode.l10n.t("CVS Rollback"),
      async (adapter, signal) => {
        const confirmed = await vscode.window.showWarningMessage(
          vscode.l10n.t(
            "Rollback {0} CVS file(s)? A sibling backup will be kept.",
            paths.length,
          ),
          { modal: true },
          vscode.l10n.t("Rollback"),
        );
        if (confirmed !== vscode.l10n.t("Rollback")) return;
        await this.guard();
        if (await hasDirtyEditors(this.root))
          throw new Error(
            vscode.l10n.t("Save unsaved editors before rolling back."),
          );
        const backups = [];
        for (const file of paths)
          backups.push(await adapter.rollback(file, signal));
        void vscode.window.showInformationMessage(
          vscode.l10n.t(
            "CVS rollback completed. Backups: {0}",
            backups.join(", "),
          ),
        );
      },
      true,
    );
  }
  private uri(file: string, revision: string) {
    return vscode.Uri.from({
      scheme: "jettortoise",
      authority: this.id,
      path: `/${file}`,
      query: new URLSearchParams({ ref: revision }).toString(),
    });
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
    const parts = revision.split(".").map(Number);
    let previous = "empty";
    if (parts[parts.length - 1] > 1)
      previous = [...parts.slice(0, -1), parts[parts.length - 1] - 1].join(".");
    else if (parts.length > 2) previous = parts.slice(0, -2).join(".");
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
  async readFile(uri: vscode.Uri) {
    await this.guard();
    if (uri.authority !== this.id)
      throw new Error(vscode.l10n.t("Repository mismatch."));
    const file = uri.path.slice(1);
    await assertOwnedPath(this.root, "cvs", file);
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
          : adapter.content(file, revision, signal);
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
