import * as vscode from "vscode";
import type { MessageRouter } from "../messages/messageRouter";
import { getWebviewHtml } from "./html";

/**
 * Opens a "Push Commits" webview panel in an editor tab,
 * similar to IntelliJ IDEA's push dialog.
 */
export class PushPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly messageRouter: MessageRouter,
  ) {}

  open(branchName: string, remoteName = "origin"): void {
    if (this.panel) {
      this.panel.reveal();
      // Re-send init data
      this.panel.webview.postMessage({
        type: "event",
        event: "pushPanelInit",
        data: { branchName, remoteName },
      });
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "jettortoise.git.pushPanel",
      vscode.l10n.t("Push Commits to {0}", branchName),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
        retainContextWhenHidden: false,
      },
    );

    this.panel.webview.html = getWebviewHtml(
      this.panel.webview,
      this.extensionUri,
      "push",
      { branch: branchName, remote: remoteName },
    );

    const routerDisposable = this.messageRouter.registerWebview(
      this.panel.webview,
      "push",
    );

    this.panel.onDidDispose(() => {
      routerDisposable.dispose();
      this.panel = undefined;
    });
  }

  close(): void {
    this.panel?.dispose();
  }
  dispose(): void {
    this.panel?.dispose();
  }
}
