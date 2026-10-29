import * as path from "node:path";
import * as vscode from "vscode";
import { assertOwnedPath } from "../repositories/boundaries.cjs";
import type { ChangeFile, RepositorySnapshot } from "../repositories/changes";
import { hasDirtyEditors } from "../repositories/editor-documents";

interface CvsFile {
  newPath: string;
  entryRevision: string;
  state: string;
  status?: string;
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
  ): Promise<Buffer>;
  commit(names: string[], message: string, signal?: AbortSignal): Promise<void>;
  rollback(name: string, signal?: AbortSignal): Promise<string>;
  add(names: string[], signal?: AbortSignal): Promise<void>;
  update(signal?: AbortSignal): Promise<void>;
}
interface Process {
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
      run: async (...args) => {
        await guard();
        if (this.disposed) throw new Error("Repository removed.");
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
      const local = await this.adapter.localStatus(paths);
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
          const result = await this.adapter.status(signal);
          await this.localTail;
          await this.guard();
          this.files = result;
          this.error = undefined;
          // 重新读当前文件时间戳，避免迟到的网络结果覆盖保存后的本地状态。
          const current = await this.adapter.localStatus();
          const unknown = result.filter((file) => file.state === "Unknown");
          this.files = [
            ...current.filter((file) => file.state !== "Unknown"),
            ...unknown,
          ];
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
  ): Promise<T> {
    try {
      return await this.queue.run(async (signal) => {
        await this.guard();
        if (this.disposed) throw new Error("Repository removed.");
        if (dirty && (await hasDirtyEditors(this.root)))
          throw new Error("Save unsaved editors before modifying files.");
        return vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
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
      "CVS Commit",
      (adapter, signal) => adapter.commit(paths, message, signal),
      true,
    );
  }
  add(paths: string[]) {
    return this.operate(
      "CVS Add",
      (adapter, signal) => adapter.add(paths, signal),
      true,
    );
  }
  update() {
    return this.operate(
      "Update Project",
      (adapter, signal) => adapter.update(signal),
      true,
    );
  }
  history(file: string) {
    return this.operate("CVS File History", (adapter, signal) =>
      adapter.log(file, signal),
    );
  }
  async rollback(paths: string[]) {
    return this.operate(
      "CVS Rollback",
      async (adapter, signal) => {
        const confirmed = await vscode.window.showWarningMessage(
          `Rollback ${paths.length} CVS file(s)? A sibling backup will be kept.`,
          { modal: true },
          "Rollback",
        );
        if (confirmed !== "Rollback") return;
        await this.guard();
        if (await hasDirtyEditors(this.root))
          throw new Error("Save unsaved editors before rolling back.");
        const backups = [];
        for (const file of paths)
          backups.push(await adapter.rollback(file, signal));
        void vscode.window.showInformationMessage(
          `CVS rollback completed. Backups: ${backups.join(", ")}`,
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
  async diff(file: string) {
    await this.guard();
    const entry = await this.adapter.file(file);
    const revision = entry.entryRevision.replace(/^-/, "");
    const left = this.uri(file, revision === "0" ? "empty" : revision);
    const right =
      entry.state === "Locally Removed" || entry.state === "Missing"
        ? this.uri(file, "empty")
        : vscode.Uri.file(path.join(this.root, file));
    await vscode.commands.executeCommand(
      "vscode.diff",
      left,
      right,
      `${file} (BASE ${revision} ↔ working tree)`,
    );
  }
  async revisionDiff(file: string, revision: string) {
    const history = await this.history(file);
    if (!history.some((entry) => entry.revisionId === revision))
      throw new Error("Unknown revision.");
    const parts = revision.split(".").map(Number);
    let previous = "empty";
    if (parts[parts.length - 1] > 1)
      previous = [...parts.slice(0, -1), parts[parts.length - 1] - 1].join(".");
    else if (parts.length > 2) previous = parts.slice(0, -2).join(".");
    if (
      previous !== "empty" &&
      !history.some((entry) => entry.revisionId === previous)
    )
      throw new Error("Previous revision is unavailable.");
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
    if (uri.authority !== this.id) throw new Error("Repository mismatch.");
    const file = uri.path.slice(1);
    await assertOwnedPath(this.root, "cvs", file);
    const revision = new URLSearchParams(uri.query).get("ref") ?? "";
    if (revision === "empty") return Buffer.alloc(0);
    return this.operate("CVS revision", (adapter, signal) =>
      adapter.content(file, revision, signal),
    );
  }
  dispose() {
    this.disposed = true;
    this.queue.cancel();
  }
}
export function cvsErrorText(error: unknown): string {
  const code = (error as { code?: string })?.code;
  const messages: Record<string, string> = {
    command:
      "CVS failed. Check repository access and working copy state, then refresh.",
    missingClient:
      "CVS was not found. Set JetTortoise: CVS Path to an installed client.",
    cancelled:
      "CVS cancelled. Refresh to check whether files were partly changed.",
    timeout: "CVS timed out. Refresh before retrying.",
    commitState:
      "Selected files cannot be committed. Refresh and resolve conflicts first.",
    NESTED_REPOSITORY: "Nested repositories block this operation.",
    BOUNDARY_UNAVAILABLE: "Repository boundaries could not be fully verified.",
  };
  return code
    ? (messages[code] ?? `CVS could not complete the operation (${code}).`)
    : error instanceof Error
      ? error.message
      : "CVS operation failed.";
}
