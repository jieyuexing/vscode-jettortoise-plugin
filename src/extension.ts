import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { CvsRepositorySession, checkoutCvs } from "./cvs/session";
import { safeRelativePath } from "./git/security";
import { createGitRepositorySession } from "./git/session";
import { setBoundaryDiagnostic } from "./repositories/boundaries.cjs";
import type {
  CatalogAction,
  WorkbenchConnection,
} from "./repositories/catalog-channel";
import { boundaryErrorText } from "./repositories/navigation";
import { RepositoryRegistry, within } from "./repositories/registry";
import type {
  RepositoryDescriptor,
  RepositoryKind,
} from "./repositories/types";
import { ScmManager } from "./scm/manager";

function resourceUri(value: unknown): vscode.Uri | undefined {
  if (value instanceof vscode.Uri) return value;
  if (value && typeof value === "object") {
    for (const key of ["resourceUri", "sourceUri"]) {
      const uri = (value as Record<string, unknown>)[key];
      if (uri instanceof vscode.Uri) return uri;
    }
  }
  return undefined;
}
export function activate(context: vscode.ExtensionContext) {
  const output = vscode.window.createOutputChannel("JetTortoise");
  setBoundaryDiagnostic(({ stage, path: target }) =>
    output.appendLine(
      `[BOUNDARY_UNAVAILABLE] ${stage}: ${target
        .replace(/[\r\n]/g, " ")
        .replace(/(:pserver:)[^@\s]*@/gi, "$1[redacted]@")
        .slice(0, 4096)}`,
    ),
  );
  context.subscriptions.push(output, {
    dispose: () => setBoundaryDiagnostic(undefined),
  });

  const registry: RepositoryRegistry = new RepositoryRegistry(
    (repository, guard, onActive) =>
      repository.kind === "git"
        ? createGitRepositorySession(
            context,
            repository,
            guard,
            onActive,
            navigation(repository),
            {
              ...workbench,
              refreshReference: () => registry.refreshReference(repository.id),
            },
          )
        : new CvsRepositorySession(
            context,
            { ...repository, kind: "cvs" },
            guard,
            onActive,
            navigation(repository),
            {
              ...workbench,
              refreshReference: () => registry.refreshReference(repository.id),
            },
          ),
    {
      saved: context.workspaceState?.get("repositories"),
      registered: context.workspaceState?.get("repositoryRegistrations"),
      save: (value) => {
        return context.workspaceState?.update("repositoryRegistrations", value);
      },
    },
  );
  let scanController: AbortController | undefined;
  let scanTask: Promise<unknown> | undefined;
  const scan = async (manual = true): Promise<unknown> => {
    if (scanTask) return scanTask;
    if (!vscode.workspace.isTrusted) return;
    if (
      !manual &&
      !vscode.workspace
        .getConfiguration("jettortoise")
        .get("autoDiscoverRepositories", true)
    )
      return;
    scanController = new AbortController();
    const signal = scanController.signal;
    scanTask = Promise.resolve(
      vscode.window.withProgress(
        {
          location: vscode.ProgressLocation.Window,
          title: vscode.l10n.t("Scanning repositories"),
          cancellable: true,
        },
        async (progress, token) => {
          const cancel = token.onCancellationRequested(() =>
            scanController?.abort(),
          );
          try {
            return await registry.scanWorkspace({
              signal,
              onProgress: (state) =>
                progress.report({
                  message: vscode.l10n.t(
                    "{0} repositories found",
                    state.roots.length,
                  ),
                }),
            });
          } finally {
            cancel.dispose();
          }
        },
      ),
    );
    try {
      return await scanTask;
    } finally {
      scanTask = undefined;
      scanController = undefined;
    }
  };
  const update = async (repository: RepositoryDescriptor) => {
    registry.setActivity(repository.id, {
      ...registry.catalogEntry(repository.id)?.activity,
      status: "running",
      message: vscode.l10n.t("Updating files…"),
    });
    try {
      await registry.ensureAvailable(repository);
      const session = await registry.session(repository);
      if (!session.update)
        throw new Error(
          vscode.l10n.t("This repository does not support updating files."),
        );
      await session.update();
      await registry.refreshReference(repository.id);
      registry.setActivity(repository.id, {
        ...registry.catalogEntry(repository.id)?.activity,
        status: "success",
        message: vscode.l10n.t("Files updated"),
      });
    } catch (error) {
      const message =
        boundaryErrorText(error) ??
        (error instanceof Error
          ? error.message
          : vscode.l10n.t("Repository update failed."));
      // Git diagnostics can include a URL with credentials. Keep row feedback bounded and redacted.
      const safe = message
        .replace(/(https?:\/\/)[^\s/@]+:[^\s/@]+@/gi, "$1[redacted]@")
        .slice(0, 2000);
      registry.setActivity(repository.id, {
        ...registry.catalogEntry(repository.id)?.activity,
        status: "error",
        message: safe,
      });
      throw new Error(safe);
    }
  };
  const workbench: WorkbenchConnection = {
    catalog: {
      snapshot: () => registry.snapshot(),
      subscribe: (listener) => registry.onDidChange(listener),
      async action(action: CatalogAction, id?: string) {
        if (action === "snapshot") return registry.snapshot();
        if (!vscode.workspace.isTrusted)
          throw new Error(
            vscode.l10n.t(
              "Trust this workspace before running version control operations.",
            ),
          );
        if (action === "scan") return scan();
        if (action === "cancelScan") {
          scanController?.abort();
          return;
        }
        if (action === "add") {
          await registry.add();
          return;
        }
        if (action === "restore") {
          const choice = await vscode.window.showQuickPick(
            registry
              .snapshot()
              .entries.filter((entry) => entry.hidden)
              .map((entry) => ({
                label: path.basename(entry.repository.root),
                description: entry.repository.root,
                id: entry.repository.id,
              })),
            { title: vscode.l10n.t("Restore Hidden Repository") },
          );
          if (choice) await registry.restoreHidden(choice.id);
          return;
        }
        const repository = id ? registry.repositories.get(id) : undefined;
        if (!repository)
          throw new Error(
            vscode.l10n.t("Add this repository before running operations."),
          );
        if (action === "remove") return registry.remove(repository.id);
        if (action === "copy")
          return vscode.env.clipboard.writeText(repository.root);
        await registry.ensureAvailable(repository);
        if (action === "update") return update(repository);
        const session = await registry.session(repository);
        if (action === "refresh") {
          await session.refresh();
          registry.setActivity(repository.id, {
            ...registry.catalogEntry(repository.id)?.activity,
            status: "success",
            message: vscode.l10n.t("Status refreshed"),
          });
        } else session.open(undefined, action === "commit");
      },
    },
  };
  function navigation(parent: RepositoryDescriptor) {
    return {
      children: () =>
        [...registry.repositories.values()].filter(
          (item) => item.root !== parent.root && within(parent.root, item.root),
        ),
      open: async (root: string) => {
        const child = await registry.choose(vscode.Uri.file(root));
        if (child) (await registry.session(child)).open();
      },
    };
  }
  const report = (error: unknown) =>
    vscode.window.showErrorMessage(
      error instanceof Error
        ? error.message
        : vscode.l10n.t("JetTortoise could not complete the operation."),
    );
  const run =
    (action: (...args: unknown[]) => Promise<unknown>) =>
    (...args: unknown[]) =>
      action(...args).catch(report);
  async function selected(
    value?: unknown,
    kind?: RepositoryKind,
  ): Promise<RepositoryDescriptor | undefined> {
    const uri = resourceUri(value);
    if (uri) return registry.choose(uri, kind);
    const editor = vscode.window.activeTextEditor;
    if (editor) return registry.choose(editor.document.uri, kind);
    const active = registry.activeId
      ? registry.repositories.get(registry.activeId)
      : undefined;
    if (active && (!kind || active.kind === kind)) {
      await registry.ensureAvailable(active);
      return active;
    }
    return registry.choose(undefined, kind);
  }
  async function open(commit: boolean, value?: unknown) {
    const repository =
      value === undefined && !commit
        ? await registry.choose()
        : await selected(value);
    if (!repository) return;
    const uri = resourceUri(value);
    const canonicalFile =
      uri?.scheme === "file" && !commit
        ? await fs.realpath(uri.fsPath)
        : undefined;
    const file =
      canonicalFile &&
      canonicalFile !== repository.root &&
      within(repository.root, canonicalFile)
        ? safeRelativePath(path.relative(repository.root, canonicalFile))
        : undefined;
    (await registry.session(repository)).open(file, commit);
  }
  const bind = (
    name: string,
    handler: (...args: unknown[]) => Promise<unknown>,
  ) =>
    context.subscriptions.push(
      vscode.commands.registerCommand(name, run(handler)),
    );
  bind("jettortoise.addRepository", async (value) => {
    const repository = await registry.add(resourceUri(value));
    if (repository) (await registry.session(repository)).open();
  });
  bind("jettortoise.removeRepository", () => registry.removeWithPicker());
  bind("jettortoise.scanRepositories", () => scan());
  bind("jettortoise.updateRepository", async (value) => {
    const repository =
      typeof value === "string"
        ? registry.repositories.get(value)
        : await selected(value);
    if (!repository) return;
    await update(repository);
  });
  bind("jettortoise.openHistory", (value) => open(false, value));
  bind("jettortoise.openCommit", (value) => open(true, value));
  bind("jettortoise.refresh", async (value) => {
    const repository = await selected(value);
    if (repository) await (await registry.session(repository)).refresh();
  });
  for (const name of [
    "openPushPanel",
    "openConflicts",
    "openMergeEditorFromSCM",
    "nextDiff",
    "prevDiff",
    "editSource",
  ]) {
    bind(`jettortoise.git.${name}`, async (...args) => {
      const repository = await selected(args[0], "git");
      if (repository)
        return (await registry.session(repository)).execute?.(
          `jettortoise.git.${name}`,
          ...args,
        );
    });
  }
  bind("jettortoise.cvs.update", async (value) => {
    const repository = await selected(value, "cvs");
    if (repository) await update(repository);
  });
  bind("jettortoise.cvs.cancel", async (value) => {
    const repository = await selected(value, "cvs");
    if (repository) (await registry.session(repository)).cancel?.();
  });
  bind("jettortoise.cvs.checkout", () =>
    checkoutCvs(context, async (root) => {
      const repository = await registry.choose(vscode.Uri.file(root), "cvs");
      if (repository) (await registry.session(repository)).open();
    }),
  );

  context.subscriptions.push(
    registry,
    vscode.window.registerWebviewPanelSerializer("jettortoise.workspace", {
      async deserializeWebviewPanel(panel, state) {
        try {
          await registry.restore(panel, state);
        } catch (error) {
          panel.dispose();
          void report(error);
        }
      },
    }),
  );
  const emitter = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  const readFile = async (uri: vscode.Uri) => {
    const session = await registry.resolveUri(uri);
    return session.readFile
      ? session.readFile(uri)
      : Buffer.from(await session.provideContent(uri));
  };
  const denied = () => {
    throw vscode.FileSystemError.NoPermissions();
  };
  context.subscriptions.push(
    emitter,
    vscode.workspace.registerFileSystemProvider(
      "jettortoise",
      {
        onDidChangeFile: emitter.event,
        watch: () => ({ dispose() {} }),
        async stat(uri) {
          return {
            type: vscode.FileType.File,
            ctime: 0,
            mtime: 0,
            size: (await readFile(uri)).byteLength,
          };
        },
        readDirectory: () => [],
        readFile,
        createDirectory: denied,
        writeFile: denied,
        delete: denied,
        rename: denied,
      },
      { isReadonly: true },
    ),
    vscode.workspace.registerTextDocumentContentProvider("jettortoise", {
      async provideTextDocumentContent(uri) {
        return (await registry.resolveUri(uri)).provideContent(uri);
      },
    }),
    vscode.workspace.onDidChangeWorkspaceFolders(() => {
      scanController?.abort();
      void registry.invalidateRemoved();
      void (async () => {
        try {
          await scanTask;
        } catch {
          /* The cancelled scan remains incomplete. */
        }
        await new Promise<void>((resolve) => setTimeout(resolve, 0));
        await scan(false);
      })().catch(report);
    }),
    vscode.window.onDidChangeActiveTextEditor((editor) => {
      if (!editor || editor.document.uri.scheme !== "jettortoise") {
        void vscode.commands.executeCommand(
          "setContext",
          "jettortoise.activeProvider",
          undefined,
        );
        return;
      }
      const repository = registry.repositories.get(
        editor.document.uri.authority,
      );
      if (repository) {
        registry.activeId = repository.id;
        void vscode.commands.executeCommand(
          "setContext",
          "jettortoise.activeProvider",
          repository.kind,
        );
      }
    }),
  );
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  status.text = "$(source-control) JetTortoise";
  status.tooltip = vscode.l10n.t("Open JetTortoise workspace");
  status.command = "jettortoise.openHistory";
  status.show();
  context.subscriptions.push(status, {
    dispose() {
      scanController?.abort();
    },
  });
  if (vscode.workspace.onDidChangeConfiguration)
    context.subscriptions.push(
      vscode.workspace.onDidChangeConfiguration((event) => {
        if (
          event.affectsConfiguration("jettortoise.autoDiscoverRepositories")
        ) {
          if (
            !vscode.workspace
              .getConfiguration("jettortoise")
              .get("autoDiscoverRepositories", true)
          )
            scanController?.abort();
          else void scan(false).catch(report);
        }
      }),
    );
  context.subscriptions.push(new ScmManager(registry, context));
  void scan(false).catch(report);
}
export function deactivate() {}
