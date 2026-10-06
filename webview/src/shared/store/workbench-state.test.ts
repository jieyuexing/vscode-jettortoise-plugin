import { describe, expect, it, vi } from "vitest";
import {
  createWorkbenchStateWriter,
  readWorkbenchState,
} from "./workbench-state";

describe("workbench persisted state", () => {
  it("keeps the Host repository binding across interleaved state partitions", () => {
    const save = vi.fn();
    const writer = createWorkbenchStateWriter(
      { version: 2, repository: { kind: "git", root: "/old" } },
      save,
      { kind: "git", root: "/current" },
    );
    writer.update({});
    writer.update({
      history: {
        ...writer.getState().history,
        filter: { ...writer.getState().history.filter, file: "one.ts" },
      },
    });
    writer.update({
      layout: {
        ...writer.getState().layout,
        collapsed: { commit: true, navigation: false, detail: false },
      },
    });
    expect(save.mock.calls.at(-1)?.[0].repository).toEqual({
      kind: "git",
      root: "/current",
    });
    expect(
      readWorkbenchState(save.mock.calls.at(-1)?.[0]).repository?.root,
    ).toBe("/current");
  });
  it("migrates legacy history without importing draft or file contents", () => {
    const state = readWorkbenchState({
      version: 1,
      filter: { file: "src/file.ts" },
      selectedCommitHashes: ["a".repeat(40)],
      commitMessage: "private draft",
    });
    expect(state.version).toBe(2);
    expect(state.history.filter.file).toBe("src/file.ts");
    expect(state.history.selectedCommitHashes).toEqual(["a".repeat(40)]);
    expect(state.layout.widths).toEqual({
      commit: 280,
      navigation: 220,
      detail: 260,
    });
    expect(JSON.stringify(state)).not.toContain("private draft");
  });
  it("merges interleaved layout and history updates and restores both after Reload", () => {
    const save = vi.fn();
    const writer = createWorkbenchStateWriter(undefined, save);
    const history = {
      ...writer.getState().history,
      filter: {
        ...writer.getState().history.filter,
        file: "kept.ts",
        searchQuery: "needle",
      },
    };
    writer.update({ history });
    const layout = {
      ...writer.getState().layout,
      widths: { commit: 330, navigation: 195, detail: 310 },
      collapsed: { commit: true, navigation: false, detail: true },
    };
    writer.update({ layout });
    writer.update({
      history: {
        ...history,
        visibleColumns: { author: false, date: true, hash: false },
      },
    });
    const restored = createWorkbenchStateWriter(
      save.mock.calls.at(-1)?.[0],
      vi.fn(),
    ).getState();
    expect(restored.layout).toEqual(layout);
    expect(restored.history.filter.file).toBe("kept.ts");
    expect(restored.history.visibleColumns.author).toBe(false);
    expect(save).toHaveBeenCalledTimes(3);
    writer.update({ layout });
    expect(save).toHaveBeenCalledTimes(3);
  });
  it("rejects malformed or future versions and clamps unsafe layout values", () => {
    expect(
      readWorkbenchState({
        version: 99,
        history: { filter: { file: "ignored.ts" } },
      }).history.filter.file,
    ).toBe("");
    const state = readWorkbenchState({
      version: 2,
      layout: {
        version: 1,
        widths: { commit: -1, navigation: Infinity, detail: 1e9 },
        collapsed: { commit: "false" },
      },
    });
    expect(state.layout.widths).toEqual({
      commit: 240,
      navigation: 220,
      detail: 600,
    });
    expect(state.layout.collapsed.commit).toBe(false);
  });
});
