import * as vscode from "vscode";
import type { MessageRouter } from "../messages/messageRouter";
import type { RepositoryDescriptor } from "../repositories/types";
import { getWebviewHtml } from "./html";

/**
 * Owns one fixed repository workspace tab and its ready queue.
 */
export class GitLogViewProvider implements vscode.WebviewPanelSerializer {
  public static readonly viewType = "jettortoise.workspace";

  private panel: vscode.WebviewPanel | undefined;
  private panelReady = false;
  private pendingFileHistory: string | undefined;
  private pendingCommitPanel = false;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly messageRouter: MessageRouter,
    private readonly onPanelInitialized: (() => void) | undefined,
    private readonly repository: RepositoryDescriptor,
    private readonly onActive: () => void,
    private readonly bindWorkbench?: (
      webview: vscode.Webview,
    ) => vscode.Disposable,
  ) {}

  open(): void {
    if (this.panel) {
      // Keep a user-moved history tab in its current editor group.
      this.panel.reveal();
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      GitLogViewProvider.viewType,
      this.repository.title,
      vscode.ViewColumn.Active,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
        retainContextWhenHidden: true,
      },
    );
    this.initializePanel(panel);
  }

  /**
   * Reveal the embedded commit area without creating a second VS Code view.
   * The commit and history regions share the same repository-bound page.
   */
  openCommit(): void {
    this.pendingCommitPanel = true;
    this.open();
    this.flushPendingEvents();
  }

  showFileHistory(file: string): void {
    // A sequence of file-history requests should show the file selected last.
    this.pendingFileHistory = file;
    this.open();
    this.flushPendingEvents();
  }

  async deserializeWebviewPanel(
    panel: vscode.WebviewPanel,
    _state: unknown,
  ): Promise<void> {
    // A command may open the singleton while VS Code is restoring a previous
    // window. Preserve that live tab and discard only the duplicate restore.
    if (this.panel && this.panel !== panel) {
      panel.dispose();
      return;
    }

    panel.title = this.repository.title;
    panel.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    this.initializePanel(panel);
  }

  private initializePanel(panel: vscode.WebviewPanel): void {
    this.panel = panel;
    panel.onDidChangeViewState(() => {
      if (panel.active) this.onActive();
    });
    if (panel.active) this.onActive();
    this.panelReady = false;
    this.onPanelInitialized?.();

    // Register this listener before assigning HTML: the webview can send its
    // ready notification immediately as it begins booting.
    const readyDisposable = panel.webview.onDidReceiveMessage(
      (message: unknown) => {
        if (
          typeof message === "object" &&
          message !== null &&
          "type" in message &&
          message.type === "jettortoiseHistoryReady"
        ) {
          this.panelReady = true;
          this.flushPendingEvents();
        }
      },
    );

    const routerDisposable = this.messageRouter.registerWebview(
      panel.webview,
      "panel",
    );
    const workbenchDisposable = this.bindWorkbench?.(panel.webview);

    panel.webview.html = getWebviewHtml(
      panel.webview,
      this.extensionUri,
      "panel",
      {
        repository: JSON.stringify({
          id: this.repository.id,
          kind: "git",
          root: this.repository.root,
        }),
      },
    );
    panel.onDidDispose(() => {
      readyDisposable.dispose();
      routerDisposable.dispose();
      workbenchDisposable?.dispose();
      if (this.panel === panel) {
        this.panel = undefined;
        this.panelReady = false;
        this.pendingFileHistory = undefined;
        this.pendingCommitPanel = false;
      }
    });
  }

  dispose(): void {
    this.panel?.dispose();
  }

  private flushPendingEvents(): void {
    if (!this.panel || !this.panelReady) return;

    if (this.pendingFileHistory) {
      const file = this.pendingFileHistory;
      this.pendingFileHistory = undefined;
      void this.panel.webview.postMessage({
        type: "event",
        event: "showFileHistory",
        data: { file },
      });
    }

    if (this.pendingCommitPanel) {
      this.pendingCommitPanel = false;
      void this.panel.webview.postMessage({
        type: "event",
        event: "showCommitPanel",
        data: {},
      });
    }
  }
}
