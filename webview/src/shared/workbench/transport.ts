import { getVSCodeApi } from "../bridge/vscode-api";

export interface ComparisonSelection {
  source: "staged" | "working" | "history";
  filePath: string;
  revision?: string;
  baseRef?: string;
  cherryPickHashes?: string[];
}
export interface DiffState {
  mode: "split" | "inline";
  selection?: ComparisonSelection;
}
export function readDiffState(value: unknown): DiffState {
  const candidate = value as Partial<DiffState> | undefined;
  const selection = candidate?.selection;
  return {
    mode: candidate?.mode === "inline" ? "inline" : "split",
    ...(selection &&
    ["staged", "working", "history"].includes(selection.source) &&
    typeof selection.filePath === "string"
      ? {
          selection: {
            source: selection.source,
            filePath: selection.filePath,
            ...(typeof selection.revision === "string"
              ? { revision: selection.revision }
              : {}),
            ...(typeof selection.baseRef === "string"
              ? { baseRef: selection.baseRef }
              : {}),
            ...(Array.isArray(selection.cherryPickHashes) &&
            selection.cherryPickHashes.every((hash) => typeof hash === "string")
              ? { cherryPickHashes: selection.cherryPickHashes }
              : {}),
          },
        }
      : {}),
  };
}
let sequence = 0;
/** No repository root is sent through this channel. The Host owns both bindings. */
export function workbenchRequest<T>(
  type: "jettortoiseCatalog" | "jettortoiseComparison",
  data: Record<string, unknown>,
): Promise<T> {
  const id = `workbench-${++sequence}`;
  return new Promise((resolve, reject) => {
    const done = () => {
      window.removeEventListener("message", receive);
      clearTimeout(timer);
    };
    const receive = (event: MessageEvent) => {
      if (
        event.data?.type !== "jettortoiseWorkbenchResponse" ||
        event.data.id !== id
      )
        return;
      done();
      if (event.data.ok) resolve(event.data.data as T);
      else reject(new Error(String(event.data.error ?? "Operation failed")));
    };
    // Long cancellable scans are handled by catalog snapshots, not request timeouts.
    const timer = setTimeout(
      () => {
        done();
        reject(new Error("Operation timed out"));
      },
      type === "jettortoiseCatalog" ? 10 * 60_000 : 90_000,
    );
    window.addEventListener("message", receive);
    getVSCodeApi().postMessage({ type, id, ...data });
  });
}
export function selectComparison(selection: ComparisonSelection): void {
  window.dispatchEvent(
    new CustomEvent("jettortoise-select-comparison", { detail: selection }),
  );
}
