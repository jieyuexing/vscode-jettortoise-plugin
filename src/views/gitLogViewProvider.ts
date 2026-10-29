import * as vscode from "vscode";
import type { RepositoryManager } from "../repositories/manager";
import { getWebviewHtml } from "./html";
export class GitLogViewProvider implements vscode.WebviewViewProvider {
  static readonly viewType = "jettortoise.gitLog";
  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly manager: RepositoryManager,
  ) {}
  resolveWebviewView(view: vscode.WebviewView): void {
    view.webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };
    view.webview.html = getWebviewHtml(
      view.webview,
      this.extensionUri,
      "panel",
    );
    const connection = this.manager.connect(view.webview);
    view.onDidDispose(() => connection.dispose());
  }
}
