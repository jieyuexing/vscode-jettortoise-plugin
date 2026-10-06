import { create } from "zustand";
import type { VcsLayoutState } from "../../../../packages/vcs-ui/src/layout-state";
import { bridge } from "../bridge";
import type { DiffState } from "../workbench/transport";
import type { WorkbenchViewState } from "./workbench-state";
import { createWorkbenchStateWriter } from "./workbench-state";

export const isHistoryView =
  document.getElementById("root")?.dataset.mode === "panel";
function hostRepository(): WorkbenchViewState["repository"] {
  try {
    const value = JSON.parse(
      document.getElementById("root")?.dataset.repository ?? "null",
    );
    return value?.kind === "git" && typeof value.root === "string"
      ? { kind: "git", root: value.root }
      : undefined;
  } catch {
    return undefined;
  }
}
export const workbenchState = createWorkbenchStateWriter(
  isHistoryView ? bridge.getState?.() : undefined,
  (state) => {
    if (isHistoryView) bridge.setState?.(state);
  },
  hostRepository(),
);
// Save the Host binding even before the user changes a filter or layout.
if (isHistoryView) workbenchState.update({});

interface WorkbenchStore {
  layout: VcsLayoutState;
  diff: DiffState;
  setDiff: (diff: DiffState) => void;
  commitRevealRequest: number;
  setLayout: (layout: VcsLayoutState) => void;
  revealCommit: () => void;
}
export const useWorkbenchStore = create<WorkbenchStore>((set) => ({
  layout: workbenchState.getState().layout,
  diff: workbenchState.getState().diff,
  setDiff: (diff) => {
    workbenchState.update({ diff });
    set({ diff: workbenchState.getState().diff });
  },
  commitRevealRequest: 0,
  setLayout: (layout) => {
    workbenchState.update({ layout });
    set({ layout: workbenchState.getState().layout });
  },
  revealCommit: () =>
    set((state) => ({ commitRevealRequest: state.commitRevealRequest + 1 })),
}));
