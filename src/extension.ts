import * as vscode from "vscode";
import { RepositoryManager } from "./repositories/manager";
import { CommitViewProvider } from "./views/commitViewProvider";
import { GitLogViewProvider } from "./views/gitLogViewProvider";

export function activate(context: vscode.ExtensionContext) {
  const manager = new RepositoryManager(context);
  context.subscriptions.push(manager);
  for (const [viewType, provider] of [
    [
      CommitViewProvider.viewType,
      new CommitViewProvider(context.extensionUri, manager),
    ],
    [
      GitLogViewProvider.viewType,
      new GitLogViewProvider(context.extensionUri, manager),
    ],
  ] as const)
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(viewType, provider, {
        webviewOptions: { retainContextWhenHidden: true },
      }),
    );
  const changes = new vscode.EventEmitter<vscode.FileChangeEvent[]>();
  const readonly = () => {
    throw vscode.FileSystemError.NoPermissions("Read-only revision content.");
  };
  context.subscriptions.push(
    changes,
    vscode.workspace.registerTextDocumentContentProvider("jettortoise", {
      provideTextDocumentContent: async (uri) =>
        Buffer.from(await manager.readFile(uri)).toString("utf8"),
    }),
    vscode.workspace.registerFileSystemProvider(
      "jettortoise",
      {
        onDidChangeFile: changes.event,
        watch: () => new vscode.Disposable(() => {}),
        stat: async (uri) => ({
          type: vscode.FileType.File,
          ctime: 0,
          mtime: 0,
          size: (await manager.readFile(uri)).byteLength,
        }),
        readDirectory: () => [],
        readFile: (uri) => manager.readFile(uri),
        writeFile: readonly,
        delete: readonly,
        rename: readonly,
        createDirectory: readonly,
      },
      { isReadonly: true },
    ),
  );
  const commands = [
    "openPushPanel",
    "openMergeEditor",
    "openDiffEditor",
    "openConflicts",
    "openMergeEditorFromSCM",
    "showFileHistory",
    "nextDiff",
    "prevDiff",
    "editSource",
  ];
  for (const command of commands)
    context.subscriptions.push(
      vscode.commands.registerCommand(
        `jettortoise.${command}`,
        (...args: unknown[]) =>
          manager.execute(`jettortoise.${command}`, ...args),
      ),
    );
  context.subscriptions.push(
    vscode.commands.registerCommand("jettortoise.refreshLog", () =>
      manager.broadcast("gitStateChanged", { scope: "all" }),
    ),
  );
  for (const command of [
    "refresh",
    "commit",
    "commitAndPush",
    "shelve",
    "unshelve",
  ])
    context.subscriptions.push(
      vscode.commands.registerCommand(
        `jettortoise.commitPanel.${command}`,
        () => manager.broadcast("commitCommand", { command }),
      ),
    );
  const status = vscode.window.createStatusBarItem(
    vscode.StatusBarAlignment.Left,
    100,
  );
  status.text = "$(git-branch) JetTortoise";
  status.tooltip = "Open JetTortoise Log";
  status.command = "jettortoise.gitLog.focus";
  status.show();
  context.subscriptions.push(status);
  void manager
    .scan()
    .catch((error) =>
      vscode.window.showErrorMessage(
        `JetTortoise discovery: ${error instanceof Error ? error.message : "Unable to read workspace."}`,
      ),
    );
}
