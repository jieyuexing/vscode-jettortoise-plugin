import {
  readVcsLayoutState,
  type VcsLayoutState,
} from "../../../../packages/vcs-ui/src/layout-state";
import { type DiffState, readDiffState } from "../workbench/transport";
import { type HistoryViewState, readHistoryState } from "./history-state";

/** Only history preferences and layout persist. Commit drafts remain in memory. */
export interface WorkbenchViewState {
  version: 2;
  repository?: { kind: "git"; root: string };
  history: HistoryViewState;
  layout: VcsLayoutState;
  diff: DiffState;
}

export function readWorkbenchState(value: unknown): WorkbenchViewState {
  const saved =
    value &&
    typeof value === "object" &&
    "version" in value &&
    value.version === 2
      ? (value as Partial<WorkbenchViewState>)
      : undefined;
  return {
    version: 2,
    ...(saved?.repository?.kind === "git" &&
    typeof saved.repository.root === "string"
      ? { repository: { kind: "git" as const, root: saved.repository.root } }
      : {}),
    history: readHistoryState(saved ? saved.history : value),
    layout: readVcsLayoutState(saved?.layout),
    diff: readDiffState(saved?.diff),
  };
}

/** A single owner merges both partitions before writing VS Code webview state. */
export function createWorkbenchStateWriter(
  initial: unknown,
  write: (state: WorkbenchViewState) => void,
  repository?: WorkbenchViewState["repository"],
) {
  let state = readWorkbenchState(initial);
  if (repository) state = { ...state, repository };
  // The first update also upgrades the legacy envelope, even if preferences match.
  let lastSaved = JSON.stringify(initial);
  const update = (
    patch: Partial<Pick<WorkbenchViewState, "history" | "layout" | "diff">>,
  ) => {
    state = readWorkbenchState({ ...state, ...patch });
    const next = JSON.stringify(state);
    if (next !== lastSaved) {
      lastSaved = next;
      write(state);
    }
  };
  return { getState: () => state, update };
}
