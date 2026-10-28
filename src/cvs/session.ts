import { AsyncLocalStorage } from "node:async_hooks";
import { randomUUID } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import { CvsComparisonResolver } from "../comparison/resolver";
import { resolveWorktreePath } from "../git/security";
import { assertOwnedPath } from "../repositories/boundaries.cjs";
import {
  bindWorkbenchChannel,
  type ComparisonAction,
  type ComparisonSelection,
  type WorkbenchConnection,
} from "../repositories/catalog-channel";
import { hasDirtyEditors } from "../repositories/editor-documents";
import {
  BoundaryNavigation,
  boundaryErrorText,
  type RepositoryNavigation,
} from "../repositories/navigation";
import { ignorePaths } from "../scm/ignore";
import type { ScmAdapter, ScmChange } from "../scm/types";
import { getWebviewHtml } from "../views/html";

// The CLI core remains JavaScript so its process and filesystem behavior is the
// reviewed CVS implementation migrated from JetCVS. esbuild bundles this ESM
// module into the extension output.
// eslint-disable-next-line @typescript-eslint/no-require-imports
interface CvsFile {
  newPath: string;
  entryRevision: string;
  state: string;
}
interface CvsAdapter {
  getNestedBoundaries(): Array<{ kind: "git" | "cvs"; root: string }>;
  status(signal?: AbortSignal, local?: CvsFile[]): Promise<CvsFile[]>;
  localStatus(names?: string[]): Promise<CvsFile[]>;
  add(names: string[], signal?: AbortSignal): Promise<void>;
  log(name: string, signal?: AbortSignal): Promise<unknown[]>;
  file(name: string): Promise<CvsFile>;
  content(
    name: string,
    revision: string,
    signal?: AbortSignal,
  ): Promise<Buffer>;
  update(signal?: AbortSignal): Promise<void>;
  commit(names: string[], message: string, signal?: AbortSignal): Promise<void>;
  rollback(name: string, signal?: AbortSignal): Promise<string>;
}
interface CvsCore {
  CvsError: new (code: string) => Error & { code: string };
  CvsProcess: new (executable?: string) => unknown;
  CvsAdapter: new (root: string, process?: unknown) => CvsAdapter;
  SerialQueue: new () => {
    controllers: Set<AbortController>;
    run<T>(job: (signal: AbortSignal) => PromiseLike<T>): Promise<T>;
    cancel(): void;
  };
  checkout(
    process: unknown,
    root: string,
    module: string,
    target: string,
    signal?: AbortSignal,
  ): Promise<string>;
}
const cvs = require("./core.mjs") as CvsCore;
// eslint-disable-next-line @typescript-eslint/no-require-imports
const protocol = require("./protocol.mjs") as {
  capabilities: Record<string, boolean>;
  validateMessage(input: unknown, surface: string): Record<string, unknown>;
};

export interface CvsRepositoryDescriptor {
  id: string;
  kind: "cvs";
  root: string;
  title: string;
}

type Pending = { focusCommit: boolean };

export class CvsRepositorySession {
  private readonly responses = new AsyncLocalStorage<{
    panel: vscode.WebviewPanel | undefined;
  }>();
  private readonly queue = new cvs.SerialQueue();
  private readonly boundaryNavigation: BoundaryNavigation;
  private readonly scmChanged = new vscode.EventEmitter<void>();
  private readonly scmRefreshed = new vscode.EventEmitter<ScmChange[]>();
  private readonly snapshots = new Map<string, Buffer>();
  private panel: vscode.WebviewPanel | undefined;
  private panelReady = false;
  private pending: Pending = { focusCommit: false };
  private pendingFile: string | undefined;
  private adapter: CvsAdapter | undefined;
  private readonly disposables: vscode.Disposable[] = [];

  constructor(
    private readonly context: vscode.ExtensionContext,
    public readonly repository: CvsRepositoryDescriptor,
    private readonly ensureAvailable: () => Promise<void>,
    private readonly onActive?: () => void,
    navigation?: RepositoryNavigation,
    private readonly workbench?: WorkbenchConnection,
  ) {
    this.boundaryNavigation = new BoundaryNavigation(repository, navigation);
  }

  readonly scm: ScmAdapter = {
    onDidChange: this.scmChanged.event,
    onDidRefresh: this.scmRefreshed.event,
    refresh: async (request, publish) => {
      try {
        const adapter = await this.getAdapter();
        const local = await adapter.localStatus(request.paths);
        await this.ensureAvailable();
        publish(
          local.filter((file) => file.state !== "Up-to-date").map(scmCvsChange),
        );
        if (request.network)
          await this.queue.run(async (signal) => {
            await this.ensureAvailable();
            const files = await adapter.status(signal, local);
            await this.ensureAvailable();
            publish(
              files
                .filter((file) => file.state !== "Up-to-date")
                .map(scmCvsChange),
            );
          });
      } catch (error) {
        throw new Error(this.errorText(error));
      }
    },
    diff: async (change) => {
      await this.operate(async (signal) => {
        await this.openDiff(
          await this.getAdapter(),
          change.path,
          undefined,
          signal,
        );
      }, true);
    },
    baseline: async (uri) => {
      if (uri.scheme !== "file") return;
      const name = path
        .relative(this.repository.root, uri.fsPath)
        .split(path.sep)
        .join("/");
      try {
        const file = await (await this.getAdapter()).file(name);
        if (!file.entryRevision || file.entryRevision === "0") return;
        return this.baseUri(name, file.entryRevision.replace(/^-/, ""));
      } catch {
        return;
      }
    },
    commit: async (paths, message) => {
      await this.operate(async (signal) => {
        const adapter = await this.getAdapter();
        await this.checkDirty();
        await adapter.commit(paths, message, signal);
        this.post({ type: "committed" });
      }, true);
      this.scmChanged.fire();
      return true;
    },
    rollback: async (paths) => {
      await this.operate(async (signal) => {
        const adapter = await this.getAdapter();
        for (const name of paths) await this.rollback(adapter, name, signal);
      }, true);
    },
    add: async (paths) => {
      await this.operate(async (signal) => {
        await this.checkDirty();
        await (await this.getAdapter()).add(paths, signal);
      }, true);
      this.scmChanged.fire();
    },
    ignore: async (paths) => {
      await this.operate(async () => {
        await this.checkDirty();
        await ignorePaths(
          this.repository.root,
          "cvs",
          paths,
          this.ensureAvailable,
        );
      }, true);
      this.scmChanged.fire();
    },
  };
  private baseUri(file: string, revision: string): vscode.Uri {
    return vscode.Uri.from({
      scheme: "jettortoise",
      authority: this.repository.id,
      path: `/${file}`,
      query: new URLSearchParams({ ref: revision }).toString(),
    });
  }

  open(file?: string, commit = false): void {
    this.onActive?.();
    if (!this.panel) {
      const panel = vscode.window.createWebviewPanel(
        "jettortoise.workspace",
        this.repository.title,
        vscode.ViewColumn.Active,
        { enableScripts: true, retainContextWhenHidden: true },
      );
      this.bind(panel);
    } else {
      this.panel.reveal();
    }
    if (commit) {
      this.pending.focusCommit = true;
      this.flush();
    }
    if (file) {
      this.pendingFile = file;
      this.flush();
    }
  }

  restore(panel: vscode.WebviewPanel): void {
    if (this.panel && this.panel !== panel) {
      panel.dispose();
      return;
    }
    this.bind(panel);
  }

  async refresh(): Promise<void> {
    await this.operate(async (signal) => this.sendState(signal), true);
  }

  async update(): Promise<void> {
    await this.operate(async (signal) => {
      const adapter = await this.getAdapter();
      await this.checkDirty();
      await adapter.update(signal);
      await this.sendState(signal);
    }, true);
  }

  cancel(): void {
    this.queue.cancel();
  }

  private async content(uri: vscode.Uri): Promise<Buffer> {
    await this.ensureAvailable();
    if (uri.scheme !== "jettortoise" || uri.authority !== this.repository.id)
      throw vscode.FileSystemError.NoPermissions();
    let content = this.snapshots.get(uri.toString());
    if (content === undefined && uri.query) {
      const revision = new URLSearchParams(uri.query).get("ref");
      if (revision)
        content = await (await this.getAdapter()).content(
          uri.path.slice(1),
          revision,
        );
    }
    if (content === undefined) throw vscode.FileSystemError.FileNotFound();
    return content;
  }

  async provideContent(uri: vscode.Uri): Promise<string> {
    return (await this.content(uri)).toString("utf8");
  }

  async readFile(uri: vscode.Uri): Promise<Uint8Array> {
    return this.content(uri);
  }

  dispose(): void {
    this.queue.cancel();
    this.scmChanged.dispose();
    this.scmRefreshed.dispose();
    this.panel?.dispose();
    this.snapshots.clear();
    for (const disposable of this.disposables.splice(0)) disposable.dispose();
  }

  private bind(panel: vscode.WebviewPanel): void {
    if (this.panel === panel) return;
    this.panel = panel;
    this.panelReady = false;
    panel.title = this.repository.title;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [
        vscode.Uri.joinPath(this.context.extensionUri, "dist"),
      ],
    };
    const receive = panel.webview.onDidReceiveMessage((raw: unknown) =>
      this.receive(raw),
    );
    const workbench = bindWorkbenchChannel(
      panel.webview,
      this.workbench,
      this.ensureAvailable,
      (action, selection) => this.compare(action, selection),
    );
    const dispose = panel.onDidDispose(() => {
      workbench.dispose();
      receive.dispose();
      if (this.panel === panel) {
        this.panel = undefined;
        this.panelReady = false;
        this.pendingFile = undefined;
        this.pending.focusCommit = false;
      }
    });
    const visible = panel.onDidChangeViewState(() => {
      if (panel.active) this.onActive?.();
    });
    this.disposables.push(receive, dispose, visible);
    panel.webview.html = getWebviewHtml(
      panel.webview,
      this.context.extensionUri,
      "cvs",
      {
        repository: JSON.stringify({
          id: this.repository.id,
          kind: "cvs",
          root: this.repository.root,
        }),
      },
    );
  }

  private async getAdapter(): Promise<CvsAdapter> {
    await this.ensureAvailable();
    if (!vscode.workspace.isTrusted) throw new cvs.CvsError("workingCopy");
    this.adapter ??= new cvs.CvsAdapter(
      this.repository.root,
      new cvs.CvsProcess(
        vscode.workspace
          .getConfiguration("jettortoise")
          .get<string>("cvsPath", "cvs"),
      ),
    );
    return this.adapter;
  }

  private async checkDirty(): Promise<void> {
    if (await hasDirtyEditors(this.repository.root))
      throw new cvs.CvsError("dirty");
  }

  private async receive(raw: unknown): Promise<void> {
    if (
      raw &&
      typeof raw === "object" &&
      "type" in raw &&
      ["jettortoiseCatalog", "jettortoiseComparison"].includes(String(raw.type))
    )
      return;
    let message: Record<string, unknown>;
    try {
      message = protocol.validateMessage(raw, "workspace") as Record<
        string,
        unknown
      >;
    } catch (error) {
      this.post({ type: "error", message: this.errorText(error) });
      return;
    }
    if (message.type === "ready") {
      this.panelReady = true;
      this.post({
        type: "init",
        language: vscode.env.language,
        surface: "workspace",
        capabilities: protocol.capabilities,
        repository: {
          id: this.repository.id,
          kind: "cvs",
          root: this.repository.root,
        },
      });
      this.flush();
      void this.refresh().catch(() => {});
      return;
    }
    if (message.type === "cancel") {
      this.cancel();
      return;
    }
    await this.operate(async (signal) => this.handle(message, signal));
  }

  private async handle(
    message: Record<string, unknown>,
    signal: AbortSignal,
  ): Promise<void> {
    const adapter = await this.getAdapter();
    switch (message.type) {
      case "openRepositoryBoundary":
        return this.boundaryNavigation.open(message.boundaryId as string);
      case "refresh":
        return this.sendState(signal);
      case "history":
        return this.post({
          type: "history",
          path: message.path,
          revisions: await adapter.log(message.path as string, signal),
        });
      case "diff":
        return this.openDiff(
          adapter,
          message.path as string,
          undefined,
          signal,
        );
      case "compare":
        return this.openDiff(
          adapter,
          message.path as string,
          message.revision as string,
          signal,
        );
      case "copy":
        return vscode.env.clipboard.writeText(message.revision as string);
      case "update":
        await this.checkDirty();
        await adapter.update(signal);
        return this.sendState(signal);
      case "commit":
        await this.checkDirty();
        await adapter.commit(
          message.paths as string[],
          message.message as string,
          signal,
        );
        this.post({ type: "committed" });
        return this.sendState(signal);
      case "rollback":
        return this.rollback(adapter, message.path as string, signal);
      default:
        return;
    }
  }

  private async rollback(
    adapter: CvsAdapter,
    file: string,
    signal: AbortSignal,
  ): Promise<void> {
    await this.checkDirty();
    const confirm = vscode.l10n.t("Restore base revision");
    const accepted = await vscode.window.showWarningMessage(
      vscode.l10n.t(
        "Discard saved changes in {0}? JetTortoise keeps a sibling backup and restores the working base revision.",
        file,
      ),
      { modal: true },
      confirm,
    );
    if (accepted !== confirm) return;
    await this.ensureAvailable();
    const origin = this.responses.getStore();
    if (origin?.panel && origin.panel !== this.panel)
      throw new cvs.CvsError("cancelled");
    await this.checkDirty();
    const backup = await adapter.rollback(file, signal);
    void vscode.window.showInformationMessage(
      vscode.l10n.t("Restored the base revision. Backup: {0}", backup),
    );
    await this.sendState(signal);
  }

  private async openDiff(
    adapter: CvsAdapter,
    file: string,
    revision: string | undefined,
    signal: AbortSignal,
  ): Promise<void> {
    const resolved = await new CvsComparisonResolver(
      adapter,
      this.repository.root,
    ).working(file, revision, (await adapter.localStatus([file]))[0]);
    const content =
      resolved.left.source === "empty"
        ? Buffer.alloc(0)
        : await adapter.content(
            resolved.left.path,
            resolved.left.revision!,
            signal,
          );
    const id = vscode.Uri.from({
      scheme: "jettortoise",
      authority: this.repository.id,
      path: `/${randomUUID()}/${path.basename(file)}`,
    });
    this.snapshots.set(id.toString(), content);
    while (this.snapshots.size > 32)
      this.snapshots.delete(this.snapshots.keys().next().value as string);
    const right =
      resolved.right.source === "empty"
        ? vscode.Uri.from({
            scheme: "jettortoise",
            authority: this.repository.id,
            path: `/${randomUUID()}/${path.basename(file)}`,
          })
        : vscode.Uri.file(
            await resolveWorktreePath(this.repository.root, file, {
              allowMissing: true,
            }),
          );
    if (resolved.right.source === "empty")
      this.snapshots.set(right.toString(), Buffer.alloc(0));
    await this.ensureAvailable();
    await vscode.commands.executeCommand(
      "vscode.diff",
      id,
      right,
      resolved.title,
    );
  }

  private async compare(
    action: ComparisonAction,
    selection: ComparisonSelection,
  ): Promise<unknown> {
    if (
      selection.source === "staged" ||
      selection.baseRef ||
      selection.cherryPickHashes
    )
      throw new Error("Unsupported CVS comparison");
    return this.queue.run(async (signal) => {
      const adapter = await this.getAdapter();
      if (action === "file") {
        await adapter.file(selection.filePath);
        await assertOwnedPath(this.repository.root, "cvs", selection.filePath);
        const file = await resolveWorktreePath(
          this.repository.root,
          selection.filePath,
        );
        await vscode.window.showTextDocument(
          await vscode.workspace.openTextDocument(vscode.Uri.file(file)),
        );
        return;
      }
      if (action === "native")
        return this.openDiff(
          adapter,
          selection.filePath,
          selection.revision,
          signal,
        );
      const resolver = new CvsComparisonResolver(adapter, this.repository.root);
      const resolved = await resolver.working(
        selection.filePath,
        selection.revision,
      );
      const result = await resolver.materialize(resolved, signal);
      await this.ensureAvailable();
      return {
        ...result,
        unsaved: await hasDirtyEditors(
          this.repository.root,
          selection.filePath,
        ),
      };
    });
  }

  private async sendState(signal: AbortSignal): Promise<void> {
    const adapter = await this.getAdapter();
    await this.workbench?.refreshReference?.();
    const local = await adapter.localStatus();
    this.scmRefreshed.fire(
      local.filter((file) => file.state !== "Up-to-date").map(scmCvsChange),
    );
    const files = await adapter.status(signal, local);
    this.scmRefreshed.fire(
      files.filter((file) => file.state !== "Up-to-date").map(scmCvsChange),
    );
    this.post({
      type: "state",
      files,
      boundaries: await this.boundaryNavigation.list(
        await adapter.getNestedBoundaries(),
      ),
      rootName: path.basename(this.repository.root),
      capabilities: protocol.capabilities,
    });
  }

  private async operate(
    action: (signal: AbortSignal) => PromiseLike<void>,
    propagate = false,
  ): Promise<void> {
    const panel = this.panel;
    this.post({ type: "busy", busy: true });
    try {
      await this.queue.run((signal: AbortSignal) =>
        this.responses.run({ panel }, async () => {
          if (panel && panel !== this.panel)
            throw new cvs.CvsError("cancelled");
          await this.ensureAvailable();
          return vscode.window.withProgress(
            {
              location: vscode.ProgressLocation.Notification,
              title: vscode.l10n.t("JetTortoise: CVS operation"),
              cancellable: true,
            },
            async (_progress, token) => {
              const cancellation = token.onCancellationRequested(() =>
                this.cancel(),
              );
              try {
                await action(signal);
              } finally {
                cancellation.dispose();
              }
            },
          );
        }),
      );
    } catch (error) {
      if (panel === this.panel)
        this.post({ type: "error", message: this.errorText(error) });
      if (propagate) throw new Error(this.errorText(error));
    } finally {
      this.post({ type: "busy", busy: this.queue.controllers.size > 0 });
    }
  }

  private errorText(error: unknown): string {
    const boundaryMessage = boundaryErrorText(error);
    if (boundaryMessage) return boundaryMessage;
    const code =
      error instanceof cvs.CvsError ? (error as { code: string }).code : "";
    const messages: Record<string, string> = {
      missingClient: vscode.l10n.t(
        "CVS was not found. Install a local CVS client and set JetTortoise: CVS Path.",
      ),
      workingCopy: vscode.l10n.t(
        "Open a CVS working copy folder, then refresh.",
      ),
      cancelled: vscode.l10n.t(
        "Operation cancelled. Refresh to check the working copy; CVS may have applied part of the operation.",
      ),
      timeout: vscode.l10n.t(
        "CVS timed out. Refresh to check the working copy before retrying.",
      ),
      symlink: vscode.l10n.t(
        "A symbolic link crosses the operation boundary. Use a working copy without symbolic links.",
      ),
      root: vscode.l10n.t(
        "Unsupported CVS root. Use a local repository or pserver without an embedded password.",
      ),
      commitState: vscode.l10n.t(
        "Some selected files cannot be committed. Refresh, resolve conflicts or update first.",
      ),
      changed: vscode.l10n.t(
        "The file changed during rollback. Your file and its backup were preserved.",
      ),
      inventoryLimit: vscode.l10n.t(
        "The CVS inventory exceeds 20,000 files or 10,000 directories. Use a smaller working copy.",
      ),
      outputLimit: vscode.l10n.t(
        "The operation exceeded the output or working copy size limit. Use a smaller working copy.",
      ),
      command: vscode.l10n.t(
        "CVS failed. Check repository access and working copy state in a terminal, then refresh.",
      ),
      dirty: vscode.l10n.t(
        "Save or close unsaved editors in this working copy before modifying files.",
      ),
    };
    return (
      messages[code] ??
      vscode.l10n.t(
        "JetTortoise could not complete the operation. Refresh and check the selected file and options.",
      )
    );
  }

  private post(message: unknown): void {
    const origin = this.responses.getStore();
    const panel = origin ? origin.panel : this.panel;
    if (panel === this.panel) void panel?.webview.postMessage(message);
  }
  private flush(): void {
    if (!this.panel || !this.panelReady) return;
    if (this.pendingFile) {
      const file = this.pendingFile;
      this.pendingFile = undefined;
      this.post({ type: "showFileHistory", file });
    }
    if (this.pending.focusCommit) {
      this.pending.focusCommit = false;
      this.post({ type: "focusCommit" });
    }
  }
}

/** Checkout is intentionally outside a repository session: a destination has no context yet. */
export async function checkoutCvs(
  _context: vscode.ExtensionContext,
  onComplete?: (root: string) => Promise<void> | void,
): Promise<void> {
  if (
    !vscode.workspace.isTrusted ||
    !vscode.workspace.workspaceFolders?.some(
      (folder) => folder.uri.scheme === "file",
    )
  ) {
    void vscode.window.showErrorMessage(
      vscode.l10n.t("Open a trusted local folder before checking out CVS."),
    );
    return;
  }
  const root = await vscode.window.showInputBox({
    title: vscode.l10n.t("CVS repository root"),
    prompt: vscode.l10n.t(
      "Local absolute path, :local:/path, or :pserver:user@host:/path. No embedded passwords.",
    ),
    ignoreFocusOut: true,
  });
  if (root === undefined) return;
  const module = await vscode.window.showInputBox({
    title: vscode.l10n.t("CVS module"),
    ignoreFocusOut: true,
  });
  if (!module) return;
  const target = await vscode.window.showSaveDialog({
    title: vscode.l10n.t("Choose a new checkout directory"),
    saveLabel: vscode.l10n.t("Check out"),
  });
  if (!target || target.scheme !== "file") return;
  const process = new cvs.CvsProcess(
    vscode.workspace
      .getConfiguration("jettortoise")
      .get<string>("cvsPath", "cvs"),
  );
  try {
    const destination = await vscode.window.withProgress(
      {
        location: vscode.ProgressLocation.Notification,
        title: vscode.l10n.t("JetTortoise: CVS operation"),
        cancellable: true,
      },
      async (_progress, token) => {
        const controller = new AbortController();
        const cancellation = token.onCancellationRequested(() =>
          controller.abort(),
        );
        try {
          return await cvs.checkout(
            process,
            root,
            module,
            target.fsPath,
            controller.signal,
          );
        } finally {
          cancellation.dispose();
        }
      },
    );
    void vscode.window.showInformationMessage(
      vscode.l10n.t("Checkout completed."),
    );
    await onComplete?.(destination);
  } catch {
    void vscode.window.showErrorMessage(
      vscode.l10n.t(
        "JetTortoise could not complete the CVS checkout. Check repository access and local CVS settings.",
      ),
    );
  }
}

export function scmCvsChange(file: CvsFile): ScmChange {
  const state = file.state;
  const status: ScmChange["status"] =
    state === "Unknown"
      ? "untracked"
      : ["Needs Checkout", "Needs Patch"].includes(state)
        ? "remote"
        : state === "File had conflicts on merge"
          ? "conflicted"
          : state === "Locally Added"
            ? "added"
            : ["Locally Removed", "Missing"].includes(state)
              ? "deleted"
              : "modified";
  return {
    path: file.newPath,
    status,
    detail:
      state === "Needs Merge"
        ? vscode.l10n.t("Local changes need merging with remote updates.")
        : cvsStateLabel(state),
  };
}
function cvsStateLabel(state: string): string {
  const labels: Record<string, string> = {
    Unknown: vscode.l10n.t("Unversioned Files"),
    "Up-to-date": vscode.l10n.t("Up to date"),
    "Needs Checkout": vscode.l10n.t("Remote Updates"),
    "Needs Patch": vscode.l10n.t("Remote Updates"),
    "File had conflicts on merge": vscode.l10n.t("Conflicts"),
    "Locally Modified": vscode.l10n.t("Modified"),
    "Locally Added": vscode.l10n.t("Added"),
    "Locally Removed": vscode.l10n.t("Deleted"),
    Missing: vscode.l10n.t("Missing from disk"),
  };
  return labels[state] ?? state;
}
