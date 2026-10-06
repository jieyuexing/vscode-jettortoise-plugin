import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  readVcsLayoutState,
  type VcsHistoryLabels,
  VcsHistoryLayout,
  type VcsLayoutState,
} from "../../../../packages/vcs-ui/src";
import { initializeI18n } from "../i18n";
import {
  ComparisonPreview,
  type ComparisonResult,
  previewModel,
} from "./ComparisonPreview";
import {
  type ComparisonSelection,
  readDiffState,
  selectComparison,
} from "./transport";

const posted: Array<Record<string, unknown>> = [];
const labels: VcsHistoryLabels = {
  showCommit: "Show commit",
  hideCommit: "Hide commit",
  showSidebar: "Show navigation",
  showDetail: "Show details",
  hideDetail: "Hide details",
  resizeCommit: "Resize commit",
  resizeSidebar: "Resize navigation",
  resizeDetail: "Resize details",
  maximizeDiff: "Maximize diff",
  restoreDiff: "Restore history",
  resizeDiff: "Resize diff",
};

function comparison(
  filePath: string,
  source: "working" | "history" = "working",
): ComparisonResult {
  return {
    kind: "git",
    source,
    filePath,
    title: filePath,
    left: { source: "git", path: filePath, revision: "HEAD" },
    right: { source: "worktree", path: filePath },
    leftContent: { available: true, text: "before\nkept" },
    rightContent: { available: true, text: `<malicious ${filePath}>\nkept` },
  };
}

function respond(message: Record<string, unknown>, data: unknown) {
  window.dispatchEvent(
    new MessageEvent("message", {
      data: {
        type: "jettortoiseWorkbenchResponse",
        id: message.id,
        ok: true,
        data,
      },
    }),
  );
}

function PreviewHarness({
  initial = { mode: "split" as const },
  onWrite,
}: {
  initial?: { mode: "split" | "inline"; selection?: ComparisonSelection };
  onWrite?: ReturnType<typeof vi.fn>;
}) {
  const [state, setState] = useState(initial);
  return (
    <ComparisonPreview
      state={state}
      onChange={(next) => {
        setState(next);
        onWrite?.(next);
      }}
    />
  );
}

beforeEach(() => {
  posted.splice(0);
  initializeI18n("en");
  vi.stubGlobal("acquireVsCodeApi", () => ({
    postMessage: (message: Record<string, unknown>) => posted.push(message),
    getState: () => undefined,
    setState: vi.fn(),
  }));
});
afterEach(() => vi.unstubAllGlobals());

describe("workbench comparison transport", () => {
  it("keeps the most recent explicit selection when responses arrive out of order", async () => {
    const change = vi.fn();
    render(<PreviewHarness onWrite={change} />);
    const first: ComparisonSelection = {
      source: "working",
      filePath: "first.ts",
    };
    const second: ComparisonSelection = {
      source: "history",
      filePath: "second.ts",
      revision: "abc",
    };
    act(() => selectComparison(first));
    await waitFor(() => expect(posted).toHaveLength(1));
    act(() => selectComparison(second));
    await waitFor(() => expect(posted).toHaveLength(2));
    act(() => respond(posted[1], comparison("second.ts", "history")));
    act(() => respond(posted[0], comparison("first.ts")));
    await waitFor(() => expect(screen.getByText("second.ts")).toBeTruthy());
    expect(screen.queryByText("first.ts")).toBeNull();
    expect(change).toHaveBeenLastCalledWith(
      expect.objectContaining({ selection: second }),
    );
  });

  it("refreshes the same source selection and never persists response bodies", async () => {
    vi.useFakeTimers();
    const selection: ComparisonSelection = {
      source: "staged",
      filePath: "partial.ts",
    };
    const change = vi.fn();
    render(
      <PreviewHarness
        initial={{ mode: "inline", selection }}
        onWrite={change}
      />,
    );
    await vi.waitFor(() => expect(posted).toHaveLength(1));
    expect(posted[0].selection).toEqual(selection);
    act(() => respond(posted[0], comparison("partial.ts")));
    act(() =>
      window.dispatchEvent(
        new MessageEvent("message", {
          data: { type: "event", event: "gitStateChanged" },
        }),
      ),
    );
    act(() => vi.advanceTimersByTime(201));
    await vi.waitFor(() => expect(posted).toHaveLength(2));
    expect(posted[1].selection).toEqual(selection);
    vi.useRealTimers();

    const state = readDiffState({
      mode: "inline",
      selection: {
        ...selection,
        text: "must not persist",
        unexpected: { text: "body" },
      },
    });
    expect(JSON.stringify(state)).not.toContain("must not persist");
    expect(JSON.stringify(state)).not.toContain("body");
  });

  it("models staged comparison labels and safe hunk lines without treating source text as HTML", () => {
    const selection: ComparisonSelection = {
      source: "staged",
      filePath: "partial.ts",
    };
    const result: ComparisonResult = {
      kind: "git",
      source: "working",
      filePath: "partial.ts",
      title: "partial.ts",
      left: { source: "git", path: "partial.ts", revision: "HEAD" },
      right: { source: "git", path: "partial.ts", revision: ":0" },
      leftContent: { available: true, text: "one\ntwo" },
      rightContent: { available: true, text: "one\n<img onerror=bad>" },
    };
    const model = previewModel(result, selection, "partial");
    expect(model.source).toMatch(/Staged/i);
    expect(model.left.label).toBe("HEAD");
    expect(model.right.label).toMatch(/Index/i);
    expect(
      model.hunks
        ?.flatMap((hunk) => hunk.lines)
        .some((line) => line.kind === "removed"),
    ).toBe(true);
    expect(
      model.hunks
        ?.flatMap((hunk) => hunk.lines)
        .some(
          (line) => line.kind === "added" && line.right === "<img onerror=bad>",
        ),
    ).toBe(true);
  });
});

function LayoutHarness() {
  const [layout, setLayout] = useState<VcsLayoutState>({
    version: 1,
    widths: { commit: 280, navigation: 180, detail: 280 },
    collapsed: { commit: false, navigation: false, detail: false },
  });
  return (
    <VcsHistoryLayout
      layout={layout}
      onLayoutChange={setLayout}
      labels={labels}
      repositoryList={<div>Repositories</div>}
      commit={<textarea aria-label="Commit draft" defaultValue="kept draft" />}
      sidebar={() => <div>Navigation</div>}
      toolbar={<div>Toolbar</div>}
      revisionList={<div>History</div>}
      detail={<div>Detail</div>}
      diff={<div>Preview</div>}
    />
  );
}

describe("workbench layout state", () => {
  it("migrates v1 and preserves the mounted draft while maximizing and restoring diff", () => {
    const migrated = readVcsLayoutState({
      version: 1,
      widths: { commit: 280, navigation: 180, detail: 280 },
      collapsed: { commit: false, navigation: false, detail: false },
    });
    expect(migrated.version).toBe(2);
    expect(migrated.diffHeight).toBe(55);
    render(<LayoutHarness />);
    const draft = screen.getByRole("textbox", {
      name: "Commit draft",
    }) as HTMLTextAreaElement;
    fireEvent.change(draft, { target: { value: "still here" } });
    fireEvent.click(screen.getByRole("button", { name: "Maximize diff" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "Commit draft",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("still here");
    expect(screen.getByText("History")).toBeTruthy();
    expect(
      document.querySelector(".vcs-ui-workspace-diff-fullscreen"),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Restore history" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "Commit draft",
        }) as HTMLTextAreaElement
      ).value,
    ).toBe("still here");
  });
});
