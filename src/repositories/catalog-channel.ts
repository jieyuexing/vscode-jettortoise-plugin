import * as vscode from "vscode";
import { safeGitRevision, safeRelativePath } from "../git/security";
import { boundaryErrorText } from "./navigation";

export type CatalogAction =
  | "snapshot"
  | "add"
  | "scan"
  | "cancelScan"
  | "restore"
  | "open"
  | "commit"
  | "update"
  | "refresh"
  | "copy"
  | "remove";
export interface WorkbenchCatalog {
  snapshot(): unknown;
  subscribe(listener: () => void): vscode.Disposable;
  action(action: CatalogAction, repositoryId?: string): Promise<unknown>;
}
export interface ComparisonSelection {
  source: "staged" | "working" | "history";
  filePath: string;
  revision?: string;
  baseRef?: string;
  cherryPickHashes?: string[];
}
export type ComparisonAction = "preview" | "native" | "file";
export type ComparisonHandler = (
  action: ComparisonAction,
  selection: ComparisonSelection,
) => Promise<unknown>;
export interface WorkbenchConnection {
  catalog: WorkbenchCatalog;
  refreshReference?: () => Promise<void>;
}

/** This management channel is attached only to a repository workspace panel.
 * It cannot change the repository binding of the ordinary Git/CVS protocol. */
export function bindWorkbenchChannel(
  webview: vscode.Webview,
  connection: WorkbenchConnection | undefined,
  ensureAvailable: () => Promise<void>,
  compare: ComparisonHandler,
): vscode.Disposable {
  let live = true;
  const send = (data: unknown) => {
    if (live) void webview.postMessage(data);
  };
  const snapshot = () =>
    send({
      type: "jettortoiseCatalogSnapshot",
      data: connection?.catalog.snapshot(),
    });
  const changed = connection?.catalog.subscribe(snapshot);
  const receive = webview.onDidReceiveMessage(async (raw: unknown) => {
    if (
      !raw ||
      typeof raw !== "object" ||
      !("type" in raw) ||
      !["jettortoiseCatalog", "jettortoiseComparison"].includes(
        String(raw.type),
      )
    )
      return;
    const value = raw as Record<string, unknown>;
    const id =
      typeof value.id === "string" && value.id.length <= 128 ? value.id : "";
    try {
      if (!id || !live) throw new Error("Invalid request");
      let data: unknown;
      if (value.type === "jettortoiseCatalog") {
        const action = parseCatalogRequest(value);
        if (!connection) throw new Error("Repository catalog unavailable");
        data = await connection.catalog.action(
          action,
          value.repositoryId as string | undefined,
        );
        if (live) snapshot();
      } else {
        const { action, selection } = parseComparisonRequest(value);
        await ensureAvailable();
        if (!live) return;
        data = await compare(action, selection);
      }
      send({ type: "jettortoiseWorkbenchResponse", id, ok: true, data });
    } catch (error) {
      send({
        type: "jettortoiseWorkbenchResponse",
        id,
        ok: false,
        error:
          boundaryErrorText(error) ??
          (error instanceof Error
            ? error.message
            : vscode.l10n.t("JetTortoise could not complete the operation.")),
      });
    }
  });
  return {
    dispose() {
      live = false;
      changed?.dispose();
      receive.dispose();
    },
  };
}
export function parseCatalogRequest(
  value: Record<string, unknown>,
): CatalogAction {
  if (
    Object.keys(value).some(
      (key) => !["type", "id", "action", "repositoryId"].includes(key),
    )
  )
    throw new Error("Unexpected catalog field");
  const action = value.action as CatalogAction;
  const global = ["snapshot", "add", "scan", "cancelScan", "restore"].includes(
    action,
  );
  if (
    !global &&
    !["open", "commit", "update", "refresh", "copy", "remove"].includes(action)
  )
    throw new Error("Unknown catalog action");
  if (
    global
      ? value.repositoryId !== undefined
      : typeof value.repositoryId !== "string" ||
        !/^[a-f0-9]{64}$/.test(value.repositoryId)
  )
    throw new Error("Invalid catalog repository");
  return action;
}
export function parseComparisonRequest(value: Record<string, unknown>): {
  action: ComparisonAction;
  selection: ComparisonSelection;
} {
  if (
    Object.keys(value).some(
      (key) => !["type", "id", "action", "selection"].includes(key),
    )
  )
    throw new Error("Unexpected comparison field");
  if (!["preview", "native", "file"].includes(String(value.action)))
    throw new Error("Unknown comparison action");
  if (
    !value.selection ||
    typeof value.selection !== "object" ||
    Array.isArray(value.selection)
  )
    throw new Error("Invalid comparison selection");
  const selection = value.selection as ComparisonSelection;
  if (
    Object.keys(selection).some(
      (key) =>
        ![
          "source",
          "filePath",
          "revision",
          "baseRef",
          "cherryPickHashes",
        ].includes(key),
    )
  )
    throw new Error("Unexpected comparison selection field");
  if (!["staged", "working", "history"].includes(selection.source))
    throw new Error("Invalid comparison source");
  safeRelativePath(selection.filePath);
  if (selection.source === "history") {
    safeGitRevision(selection.revision as string);
    if (selection.baseRef !== undefined) safeGitRevision(selection.baseRef);
    if (selection.cherryPickHashes !== undefined) {
      if (
        !Array.isArray(selection.cherryPickHashes) ||
        selection.cherryPickHashes.length > 1000 ||
        !selection.cherryPickHashes.every(
          (hash) =>
            typeof hash === "string" && /^[a-fA-F0-9]{7,64}$/.test(hash),
        )
      )
        throw new Error("Invalid comparison range");
    }
  } else if (
    selection.revision !== undefined ||
    selection.baseRef !== undefined ||
    selection.cherryPickHashes !== undefined
  )
    throw new Error("Unexpected working comparison revision");
  return { action: value.action as ComparisonAction, selection };
}
