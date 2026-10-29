import * as vscode from "vscode";
import type { MessageRouter } from "../messages/messageRouter";
import { getWebviewHtml } from "./html";

export class MergeEditorManager {
  private panels = new Map<string, vscode.WebviewPanel>();

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly messageRouter: MessageRouter,
  ) {}

  openMergeEditor(filePath: string, mergeMsg?: string): void {
    const existing = this.panels.get(filePath);
    if (existing) {
      existing.reveal();
      return;
    }

    const fileName = filePath.split("/").pop() ?? filePath;
    const panel = vscode.window.createWebviewPanel(
      "jettortoise.git.mergeEditor",
      vscode.l10n.t("Merge: {0}", fileName),
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
      },
    );

    panel.webview.html = getWebviewHtml(
      panel.webview,
      this.extensionUri,
      "merge",
      {
        file: filePath,
        "merge-msg": mergeMsg ?? "",
      },
    );

    const routerDisposable = this.messageRouter.registerWebview(
      panel.webview,
      "merge",
    );

    this.panels.set(filePath, panel);
    panel.onDidDispose(() => {
      this.panels.delete(filePath);
      routerDisposable.dispose();
    });

    // Maximize editor area for full-screen merge experience
    void vscode.commands.executeCommand(
      "workbench.action.maximizeEditorHideSidebar",
    );
  }

  closeMergeEditor(filePath: string): void {
    const panel = this.panels.get(filePath);
    if (panel) {
      panel.dispose();
    }
  }
  dispose(): void {
    for (const panel of this.panels.values()) panel.dispose();
    this.panels.clear();
  }
}
