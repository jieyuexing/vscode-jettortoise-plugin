import * as vscode from "vscode";
import { boundaryErrorText } from "../repositories/navigation";
import {
  ErrorCode,
  type EventMessage,
  type EventType,
  type ResponseMessage,
} from "./protocol";

export type MessageSurface =
  | "panel"
  | "merge"
  | "conflicts"
  | "push"
  | "rollback";
export type CommandHandler = (
  params: Record<string, unknown>,
) => Promise<unknown>;

export interface MessageRouterOptions {
  /** Host-owned availability check. A webview never supplies a repository path. */
  ensureAvailable?: () => Promise<void>;
  /** Serializes mutations for one repository without blocking other routers. */
  execute?: (
    command: string,
    action: () => Promise<unknown>,
  ) => Promise<unknown>;
  /** Runs immediately before the real destructive handler, never as a UI hint. */
  confirm?: (
    command: string,
    params: Readonly<Record<string, unknown>>,
  ) => Promise<boolean>;
}

type ValueRule =
  | "string"
  | "content"
  | "boolean"
  | "number"
  | "path"
  | "string[]"
  | "path[]"
  | "snapshot"
  | "diffFile"
  | "diffFiles"
  | "rollbackFiles"
  | readonly string[];
interface CommandSpec {
  surfaces: readonly MessageSurface[];
  fields?: Readonly<Record<string, ValueRule>>;
  optional?: readonly string[];
}

const allSurfaces: readonly MessageSurface[] = [
  "panel",
  "merge",
  "conflicts",
  "push",
  "rollback",
];
const panel = ["panel"] as const;
const commit = ["panel", "conflicts"] as const;
const merge = ["merge", "conflicts"] as const;
const push = ["push", "panel"] as const;
const rollback = ["rollback", "panel"] as const;
const empty = (surfaces: readonly MessageSurface[] = panel): CommandSpec => ({
  surfaces,
});
const fields = (
  surfaces: readonly MessageSurface[],
  value: Record<string, ValueRule>,
  optional: readonly string[] = [],
): CommandSpec => ({ surfaces, fields: value, optional });

/*
 * This is deliberately an allow-list. A webview operation cannot reach a
 * handler until it has an explicit transport contract below. Repository roots,
 * cwd values, and arbitrary process arguments are never client protocol.
 */
const SPECS: Readonly<Record<string, CommandSpec>> = {
  getGraphData: fields(
    panel,
    {
      maxCount: "number",
      skip: "number",
      branch: "string",
      search: "string",
      author: "string",
      file: "path",
      snapshot: "snapshot",
    },
    ["skip", "branch", "search", "author", "file", "snapshot"],
  ),
  getLog: fields(
    panel,
    {
      maxCount: "number",
      skip: "number",
      branch: "string",
      search: "string",
      author: "string",
      file: "path",
    },
    ["maxCount", "skip", "branch", "search", "author", "file"],
  ),
  loadMoreLog: fields(
    panel,
    {
      count: "number",
      skip: "number",
      branch: "string",
      search: "string",
      author: "string",
      snapshot: "snapshot",
    },
    ["branch", "search", "author", "snapshot"],
  ),
  getBranches: empty(),
  getRemoteBranches: empty(push),
  getTags: empty(),
  getStatus: empty(commit),
  getWorkingTreeChanges: empty(commit),
  getRepositoryBoundaries: empty(panel),
  openRepositoryBoundary: fields(panel, { boundaryId: "string" }),
  getShelves: empty(panel),
  getIdeaShelves: empty(panel),
  getAmendMessage: empty(panel),
  getRecentCommitMessages: empty(panel),
  getMergeState: empty(commit),
  getCherryPickState: empty(panel),
  getRebaseState: empty(panel),
  getConflictFiles: empty(commit),
  getDiff: fields(panel, { ref1: "string", ref2: "string", file: "path" }, [
    "file",
  ]),
  getFileContent: fields(panel, { ref: "string", filePath: "path" }),
  getCommitFiles: fields(panel, { hash: "string" }),
  getCommitRangeFiles: fields(["panel", "push"], { hashes: "string[]" }),
  getFileVersions: fields(merge, { filePath: "path" }),
  getAheadCommits: fields(push, { branchName: "string", remote: "string" }, [
    "remote",
  ]),
  openDiffEditor: fields(
    ["panel", "push"],
    {
      commit: "string",
      filePath: "path",
      file: "diffFile",
      baseRef: "string",
      cherryPickHashes: "string[]",
      fileList: "diffFiles",
    },
    ["filePath", "file", "baseRef", "cherryPickHashes", "fileList"],
  ),
  openMergeEditor: fields(commit, { file: "path" }),
  openConflictsPanel: empty(panel),
  closeMergeEditor: fields(merge, { filePath: "path" }),
  closePushPanel: empty(push),
  closeRollbackPanel: empty(rollback),
  openPushPanel: empty(panel),
  openRollbackPanel: fields(panel, { files: "rollbackFiles" }),
  openFile: fields(allSurfaces, { filePath: "path" }),
  openFileAtRevision: fields(panel, { ref: "string", filePath: "path" }),
  saveMergedContent: fields(merge, { filePath: "path", content: "content" }),
  stageFile: fields(["panel", "conflicts", "merge"], { filePath: "path" }),
  unstageFile: fields(panel, { filePath: "path" }),
  stageAll: empty(panel),
  unstageAll: empty(panel),
  acceptOurs: fields(commit, { filePath: "path" }),
  acceptTheirs: fields(commit, { filePath: "path" }),
  confirmCancelMerge: fields(
    merge,
    { filePath: "path", hasChanges: "boolean" },
    ["filePath"],
  ),
  checkoutBranch: fields(panel, { branchName: "string" }),
  createBranch: fields(
    panel,
    {
      newBranchName: "string",
      startPoint: "string",
      checkout: "boolean",
      force: "boolean",
    },
    ["checkout", "force"],
  ),
  deleteBranch: fields(
    panel,
    { branchName: "string", isRemote: "boolean", force: "boolean" },
    ["isRemote", "force"],
  ),
  renameBranch: fields(panel, { oldName: "string", newName: "string" }),
  mergeBranch: fields(panel, { branchName: "string" }),
  rebaseBranch: fields(panel, { onto: "string" }),
  checkoutAndRebase: fields(panel, {
    branchToCheckout: "string",
    rebaseOnto: "string",
  }),
  pushBranch: fields(panel, { branchName: "string", force: "boolean" }, [
    "force",
  ]),
  executePush: fields(
    push,
    {
      branchName: "string",
      remote: "string",
      targetBranch: "string",
      force: "boolean",
    },
    ["remote", "targetBranch", "force"],
  ),
  pullBranch: fields(["panel", "push"], { branchName: "string" }, [
    "branchName",
  ]),
  pullRebase: fields(push, { branchName: "string" }, ["branchName"]),
  pullMerge: fields(push, { branchName: "string" }, ["branchName"]),
  fetchBranch: empty(panel),
  fetchAll: empty(panel),
  cherryPick: fields(panel, { hash: "string" }),
  checkoutCommit: fields(panel, { hash: "string" }),
  cherryPickAction: fields(panel, { action: ["continue", "abort", "skip"] }),
  rebaseAction: fields(panel, { action: ["continue", "abort", "skip"] }),
  mergeAction: fields(panel, { action: ["continue", "abort"] }),
  revertFileChanges: fields(
    panel,
    { hash: "string", filePath: "path", status: "string" },
    ["status"],
  ),
  cherryPickFileChanges: fields(panel, { hash: "string", filePath: "path" }),
  resetToCommit: fields(panel, {
    hash: "string",
    mode: ["soft", "mixed", "hard"],
  }),
  revertCommit: fields(panel, { hash: "string" }),
  dropCommit: fields(panel, { hash: "string" }),
  createBranchFromCommit: fields(
    panel,
    {
      branchName: "string",
      hash: "string",
      checkout: "boolean",
      force: "boolean",
    },
    ["checkout", "force"],
  ),
  createTag: fields(
    panel,
    { tagName: "string", hash: "string", message: "string" },
    ["message"],
  ),
  commitChanges: fields(
    panel,
    { message: "string", amend: "boolean", filePaths: "path[]" },
    ["amend", "filePaths"],
  ),
  commitAndPush: fields(
    panel,
    { message: "string", amend: "boolean", filePaths: "path[]" },
    ["amend", "filePaths"],
  ),
  amendCommit: fields(panel, { message: "string" }),
  rollbackFile: fields(panel, { filePath: "path" }),
  rollbackFiles: fields(panel, { filePaths: "path[]" }),
  executeRollback: fields(rollback, {
    filePaths: "path[]",
    deleteLocalCopies: "boolean",
  }),
  deleteFiles: fields(panel, { filePaths: "path[]" }),
  revealInSystemExplorer: fields(panel, { filePath: "path" }),
  showDiffForWorkingFile: fields(
    panel,
    { filePath: "path", staged: "boolean" },
    ["staged"],
  ),
  shelveChanges: fields(panel, { message: "string", filePaths: "path[]" }, [
    "message",
    "filePaths",
  ]),
  unshelveChanges: fields(panel, { stashId: "string", drop: "boolean" }, [
    "drop",
  ]),
  deleteShelve: fields(panel, { stashId: "string" }),
  showShelfFileDiff: fields(panel, { stashId: "string", filePath: "path" }),
  unshelveFile: fields(panel, { stashId: "string", filePath: "path" }),
  ideaShelveChanges: fields(panel, { message: "string", filePaths: "path[]" }, [
    "message",
    "filePaths",
  ]),
  ideaUnshelveChanges: fields(panel, { shelfName: "string", drop: "boolean" }, [
    "drop",
  ]),
  deleteIdeaShelf: fields(panel, { shelfName: "string" }),
  showIdeaShelfFileDiff: fields(panel, {
    shelfName: "string",
    filePath: "path",
  }),
  createPatchFromShelf: fields(panel, { shelfName: "string" }),
  copyShelfPatchToClipboard: fields(panel, { shelfName: "string" }),
  importPatches: empty(panel),
  importPatchFromClipboard: empty(panel),
  createBranchPrompt: fields(
    panel,
    { branchName: "string", checkout: "boolean", force: "boolean" },
    ["branchName", "checkout", "force"],
  ),
  deleteBranchPrompt: fields(panel, { branchName: "string" }),
  compareWithCurrent: fields(panel, { branchName: "string" }),
  showMyBranches: empty(panel),
  toggleFavorite: fields(panel, { branchName: "string" }),
  navigateToHead: fields(panel, { branchName: "string" }),
  toggleBranchGroupByDirectory: empty(panel),
  setSingleClickAction: fields(panel, {
    action: ["updateBranchFilter", "navigateToHead"],
  }),
  toggleShowTags: empty(panel),
  copyToClipboard: fields(allSurfaces, { text: "string" }),
  showInputBox: fields(
    panel,
    { prompt: "string", value: "string", placeHolder: "string" },
    ["prompt", "value", "placeHolder"],
  ),
  showConfirmMessage: fields(
    panel,
    { message: "string", confirmLabel: "string" },
    ["confirmLabel"],
  ),
  showErrorNotification: fields(allSurfaces, { message: "string" }),
  showInfoNotification: fields(allSurfaces, { message: "string" }),
  refreshGitState: empty(panel),
};

export const MUTATING_COMMANDS: ReadonlySet<string> = new Set([
  "openMergeEditor",
  "saveMergedContent",
  "stageFile",
  "unstageFile",
  "stageAll",
  "unstageAll",
  "acceptOurs",
  "acceptTheirs",
  "checkoutBranch",
  "createBranch",
  "deleteBranch",
  "renameBranch",
  "mergeBranch",
  "rebaseBranch",
  "checkoutAndRebase",
  "pushBranch",
  "executePush",
  "pullBranch",
  "pullRebase",
  "pullMerge",
  "fetchBranch",
  "fetchAll",
  "cherryPick",
  "checkoutCommit",
  "cherryPickAction",
  "rebaseAction",
  "mergeAction",
  "revertFileChanges",
  "cherryPickFileChanges",
  "resetToCommit",
  "revertCommit",
  "dropCommit",
  "createBranchFromCommit",
  "createTag",
  "commitChanges",
  "commitAndPush",
  "amendCommit",
  "rollbackFile",
  "rollbackFiles",
  "executeRollback",
  "deleteFiles",
  "shelveChanges",
  "unshelveChanges",
  "deleteShelve",
  "unshelveFile",
  "ideaShelveChanges",
  "ideaUnshelveChanges",
  "deleteIdeaShelf",
  "importPatches",
  "importPatchFromClipboard",
  "createBranchPrompt",
  "deleteBranchPrompt",
]);

export function isMutatingCommand(command: string): boolean {
  return MUTATING_COMMANDS.has(command);
}

export function requiresHostConfirmation(
  command: string,
  params: Readonly<Record<string, unknown>>,
): boolean {
  if (command === "resetToCommit") return params.mode === "hard";
  if (
    command === "createBranch" ||
    command === "createBranchFromCommit" ||
    command === "createBranchPrompt"
  ) {
    return params.checkout === true;
  }
  return new Set([
    "checkoutBranch",
    "checkoutCommit",
    "checkoutAndRebase",
    "deleteBranch",
    "deleteBranchPrompt",
    "mergeBranch",
    "rebaseBranch",
    "dropCommit",
    "revertFileChanges",
    "cherryPickFileChanges",
    "rollbackFile",
    "rollbackFiles",
    "executeRollback",
    "deleteFiles",
    "deleteShelve",
    "deleteIdeaShelf",
  ]).has(command);
}

interface RegisteredWebview {
  webview: vscode.Webview;
  surface: MessageSurface;
}

export class MessageRouter {
  private webviews = new Set<RegisteredWebview>();
  private handlers = new Map<string, CommandHandler>();

  constructor(private readonly options: MessageRouterOptions = {}) {}

  handle(command: string, handler: CommandHandler): void {
    if (!SPECS[command]) {
      throw new Error(`Missing webview command specification: ${command}`);
    }
    this.handlers.set(command, handler);
  }

  registerWebview(
    webview: vscode.Webview,
    surface: MessageSurface,
  ): vscode.Disposable {
    const registered = { webview, surface };
    this.webviews.add(registered);
    const messageDisposable = webview.onDidReceiveMessage((msg: unknown) =>
      this.handleRequest(registered, msg),
    );
    return {
      dispose: () => {
        this.webviews.delete(registered);
        messageDisposable.dispose();
      },
    };
  }

  broadcastEvent(event: EventType, data: unknown): void {
    const msg: EventMessage = { type: "event", event, data };
    for (const { webview } of this.webviews) void webview.postMessage(msg);
  }

  private async handleRequest(
    registered: RegisteredWebview,
    raw: unknown,
  ): Promise<void> {
    const request = parseRequest(raw);
    if (!request) return;
    const { webview, surface } = registered;
    if (
      Object.keys(raw as object).some(
        (key) => !["type", "id", "command", "params"].includes(key),
      )
    ) {
      this.reject(
        webview,
        request.id,
        ErrorCode.UNKNOWN,
        "Unexpected message field",
      );
      return;
    }
    const spec = SPECS[request.command];
    const handler = this.handlers.get(request.command);
    if (!spec || !handler) {
      this.reject(
        webview,
        request.id,
        ErrorCode.UNKNOWN,
        vscode.l10n.t("Unknown command: {0}", request.command),
      );
      return;
    }
    if (!spec.surfaces.includes(surface)) {
      this.reject(
        webview,
        request.id,
        ErrorCode.UNKNOWN,
        vscode.l10n.t("Command is not available from this view."),
      );
      return;
    }
    const validation = validateParams(request.params, spec);
    if (validation) {
      this.reject(webview, request.id, ErrorCode.UNKNOWN, validation);
      return;
    }
    try {
      const action = async (): Promise<unknown> => {
        this.assertLive(registered);
        await this.options.ensureAvailable?.();
        this.assertLive(registered);
        if (requiresHostConfirmation(request.command, request.params)) {
          if (!this.options.confirm) {
            throw new Error(
              "Host confirmation is not configured for this action.",
            );
          }
          const confirmed = await this.options.confirm(
            request.command,
            request.params,
          );
          this.assertLive(registered);
          await this.options.ensureAvailable?.();
          this.assertLive(registered);
          if (!confirmed) return { success: false, cancelled: true };
        }
        return handler(request.params);
      };
      const data =
        isMutatingCommand(request.command) && this.options.execute
          ? await this.options.execute(request.command, action)
          : await action();
      this.sendResponse(webview, request.id, true, data);
    } catch (err: unknown) {
      this.reject(
        webview,
        request.id,
        ErrorCode.UNKNOWN,
        boundaryErrorText(err) ??
          (err instanceof Error ? err.message : String(err)),
      );
    }
  }

  private assertLive(registered: RegisteredWebview): void {
    if (!this.webviews.has(registered)) {
      throw new Error("Webview is no longer active.");
    }
  }

  private reject(
    webview: vscode.Webview,
    id: string,
    code: ErrorCode,
    message: string,
  ): void {
    this.sendResponse(webview, id, false, undefined, { code, message });
  }

  private sendResponse(
    webview: vscode.Webview,
    id: string,
    success: boolean,
    data?: unknown,
    error?: { code: ErrorCode; message: string },
  ): void {
    const response: ResponseMessage = {
      type: "response",
      id,
      success,
      data,
      error,
    };
    void webview.postMessage(response);
  }
}

function parseRequest(
  value: unknown,
):
  | { id: string; command: string; params: Record<string, unknown> }
  | undefined {
  if (
    !isPlainObject(value) ||
    value.type !== "request" ||
    typeof value.id !== "string" ||
    !value.id ||
    typeof value.command !== "string" ||
    !value.command ||
    !isPlainObject(value.params)
  ) {
    return undefined;
  }
  return { id: value.id, command: value.command, params: value.params };
}

function validateParams(
  params: Record<string, unknown>,
  spec: CommandSpec,
): string | undefined {
  const allowed = spec.fields ?? {};
  for (const key of Object.keys(params)) {
    if (!Object.hasOwn(allowed, key)) return `Unexpected request field: ${key}`;
    if (key === "cwd" || key === "repository" || key === "root") {
      return `Forbidden request field: ${key}`;
    }
  }
  for (const [key, rule] of Object.entries(allowed)) {
    const value = params[key];
    if (value === undefined && spec.optional?.includes(key)) continue;
    if (!matchesRule(value, rule)) return `Invalid request field: ${key}`;
  }
  return undefined;
}

function matchesRule(value: unknown, rule: ValueRule): boolean {
  if (Array.isArray(rule))
    return typeof value === "string" && rule.includes(value);
  if (rule === "content")
    return typeof value === "string" && value.length <= 50 * 1024 * 1024;
  if (rule === "string") {
    return (
      typeof value === "string" &&
      value.length <= 100_000 &&
      !value.includes("\0")
    );
  }
  if (rule === "boolean") return typeof value === "boolean";
  if (rule === "number") {
    return (
      typeof value === "number" &&
      Number.isSafeInteger(value) &&
      value >= 0 &&
      value <= 10_000_000
    );
  }
  if (rule === "path") return isSafeRelativePath(value);
  if (rule === "string[]") {
    return (
      Array.isArray(value) &&
      value.length <= 10_000 &&
      value.every((entry) => matchesRule(entry, "string"))
    );
  }
  if (rule === "path[]") {
    return (
      Array.isArray(value) &&
      value.length <= 10_000 &&
      value.every((entry) => isSafeRelativePath(entry))
    );
  }
  if (rule === "diffFile")
    return isSafeRelativePath(value) || isDiffFile(value);
  if (rule === "diffFiles")
    return (
      Array.isArray(value) && value.length <= 10000 && value.every(isDiffFile)
    );
  if (rule === "rollbackFiles")
    return (
      Array.isArray(value) &&
      value.length <= 10000 &&
      value.every(
        (item) =>
          isPlainObject(item) &&
          Object.keys(item).every((key) =>
            ["path", "status", "staged"].includes(key),
          ) &&
          isSafeRelativePath(item.path) &&
          [
            "added",
            "deleted",
            "modified",
            "renamed",
            "copied",
            "untracked",
            "conflict",
            "conflicted",
          ].includes(item.status as string) &&
          typeof item.staged === "boolean",
      )
    );
  if (value === null) return true;
  return (
    isPlainObject(value) &&
    Object.keys(value).every((key) =>
      ["activeLanes", "laneColors", "nextColorIndex", "colorIndex"].includes(
        key,
      ),
    ) &&
    Array.isArray(value.activeLanes) &&
    value.activeLanes.length <= 10000 &&
    value.activeLanes.every(
      (item) =>
        item === null ||
        (typeof item === "string" && /^[0-9a-f]{4,64}$/i.test(item)),
    ) &&
    Array.isArray(value.laneColors) &&
    value.laneColors.length <= 10000 &&
    value.laneColors.every((item) => item === null || isIndex(item)) &&
    isIndex(value.nextColorIndex) &&
    (value.colorIndex === undefined || isIndex(value.colorIndex))
  );
}

function isSafeRelativePath(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length > 0 &&
    value.length <= 16_384 &&
    !value.includes("\0") &&
    !value.startsWith("/") &&
    !value.startsWith("\\") &&
    !/^[a-zA-Z]:[\\/]/.test(value) &&
    !value
      .split(/[\\/]/)
      .some(
        (part) =>
          !part ||
          part === "." ||
          part === ".." ||
          part.toLowerCase() === ".git",
      )
  );
}

function isIndex(value: unknown): boolean {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= 0 &&
    value <= 10_000_000
  );
}
function isDiffFile(value: unknown): boolean {
  return (
    isPlainObject(value) &&
    Object.keys(value).every((key) =>
      ["oldPath", "newPath", "status", "isBinary"].includes(key),
    ) &&
    (value.oldPath === "" || isSafeRelativePath(value.oldPath)) &&
    (value.newPath === "" || isSafeRelativePath(value.newPath)) &&
    Boolean(value.oldPath || value.newPath) &&
    ["added", "deleted", "modified", "renamed", "copied"].includes(
      value.status as string,
    ) &&
    typeof value.isBinary === "boolean"
  );
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}
