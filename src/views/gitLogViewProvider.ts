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
    // 可见性初值写进 HTML，早于脚本加载的消息可能丢失。
    view.webview.html = getWebviewHtml(
      view.webview,
      this.extensionUri,
      "panel",
      {
        visible: String(view.visible !== false),
      },
    );
    const connection = this.manager.connect(view.webview);
    // 日志隐藏时保留上下文，告知可见性，CVS 历史只在用户看得到时查询。
    const visibility = view.onDidChangeVisibility(
      () =>
        void view.webview.postMessage({
          type: "event",
          event: "viewVisibility",
          data: { visible: view.visible },
        }),
    );
    view.onDidDispose(() => {
      visibility.dispose();
      connection.dispose();
    });
  }
}
