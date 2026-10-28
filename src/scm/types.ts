import type * as vscode from "vscode";

export type ChangeStatus =
  | "modified"
  | "added"
  | "deleted"
  | "renamed"
  | "untracked"
  | "conflicted"
  | "remote";
export interface ScmChange {
  path: string;
  oldPath?: string;
  status: ChangeStatus;
  detail?: string;
}
export interface RefreshRequest {
  network: boolean;
  paths?: string[];
}
/** 适配器属于仓库会话，所有写操作继续使用该会话的队列与确认。 */
export interface ScmAdapter {
  onDidChange: vscode.Event<void>;
  onDidRefresh?: vscode.Event<ScmChange[]>;
  refresh(
    request: RefreshRequest,
    publish: (changes: ScmChange[]) => void,
  ): Promise<void>;
  diff(change: ScmChange): Promise<void>;
  baseline(uri: vscode.Uri): Promise<vscode.Uri | undefined>;
  commit(paths: string[], message: string): Promise<boolean>;
  rollback(paths: string[]): Promise<void>;
  add(paths: string[]): Promise<void>;
  ignore(paths: string[]): Promise<void>;
}
