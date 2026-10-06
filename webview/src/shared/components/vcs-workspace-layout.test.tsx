import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { createRef, type Ref, useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  type VcsHistoryLabels,
  VcsHistoryLayout,
  type VcsHistoryLayoutHandle,
  type VcsLayoutState,
} from "../../../../packages/vcs-ui/src";

const labels: VcsHistoryLabels = {
  showCommit: "Show commit",
  hideCommit: "Hide commit",
  showSidebar: "Show navigation",
  showDetail: "Show details",
  hideDetail: "Hide details",
  resizeCommit: "Resize commit",
  resizeSidebar: "Resize navigation",
  resizeDetail: "Resize details",
};

const defaults: VcsLayoutState = {
  version: 1,
  widths: { commit: 280, navigation: 180, detail: 280 },
  collapsed: { commit: false, navigation: false, detail: false },
};

class TestResizeObserver {
  static instances: TestResizeObserver[] = [];
  constructor(private readonly callback: ResizeObserverCallback) {
    TestResizeObserver.instances.push(this);
  }
  observe() {}
  disconnect() {}
  trigger() {
    this.callback([], this as unknown as ResizeObserver);
  }
}

function LayoutHarness({
  initial = defaults,
  layoutRef,
  onLayoutChange,
}: {
  initial?: VcsLayoutState;
  layoutRef?: Ref<VcsHistoryLayoutHandle>;
  onLayoutChange?: (state: VcsLayoutState) => void;
}) {
  const [layout, setLayout] = useState(initial);
  return (
    <VcsHistoryLayout
      commit={<textarea aria-label="Commit message" defaultValue="draft" />}
      sidebar={() => <button type="button">Branches</button>}
      toolbar={<div>Toolbar</div>}
      revisionList={<div>History</div>}
      detail={<div>Details</div>}
      labels={labels}
      layout={layout}
      layoutRef={layoutRef}
      onLayoutChange={(next) => {
        setLayout(next);
        onLayoutChange?.(next);
      }}
    />
  );
}

function setWorkspaceWidth(width: number) {
  const root = document.querySelector<HTMLElement>(".vcs-ui-history-layout");
  if (!root) throw new Error("workspace was not rendered");
  Object.defineProperty(root, "clientWidth", {
    configurable: true,
    get: () => width,
  });
  act(() => TestResizeObserver.instances.at(-1)?.trigger());
}

afterEach(() => {
  cleanup();
  TestResizeObserver.instances = [];
  vi.unstubAllGlobals();
});

beforeEach(() => {
  vi.stubGlobal("ResizeObserver", TestResizeObserver);
});

describe("VcsHistoryLayout", () => {
  it("renders the four columns in order with the default widths", () => {
    const { container } = render(<LayoutHarness />);
    const columns = [
      ...container.querySelectorAll<HTMLElement>("[data-vcs-pane]"),
    ];
    expect(columns.map((column) => column.dataset.vcsPane)).toEqual([
      "commit",
      "navigation",
      "history",
      "detail",
    ]);
    expect(columns[0].style.width).toBe("280px");
    expect(columns[1].style.width).toBe("180px");
    expect(columns[3].style.width).toBe("280px");
    expect(columns[2].classList).toContain("vcs-ui-workspace-history");
  });

  it("resizes with mouse and keyboard while respecting pane limits", () => {
    const changed = vi.fn();
    render(<LayoutHarness onLayoutChange={changed} />);
    const commitDivider = screen.getByRole("separator", {
      name: "Resize commit",
    });
    fireEvent.mouseDown(commitDivider, { button: 0, clientX: 100 });
    fireEvent.mouseMove(document, { clientX: 700 });
    fireEvent.mouseUp(document);
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        widths: expect.objectContaining({ commit: 500 }),
      }),
    );

    fireEvent.keyDown(commitDivider, { key: "Home" });
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        widths: expect.objectContaining({ commit: 240 }),
      }),
    );
    fireEvent.keyDown(commitDivider, { key: "ArrowRight" });
    expect(changed).toHaveBeenLastCalledWith(
      expect.objectContaining({
        widths: expect.objectContaining({ commit: 250 }),
      }),
    );
  });

  it("keeps the mounted commit editor and its value when the pane is folded", () => {
    render(<LayoutHarness />);
    const editor = screen.getByRole("textbox", { name: "Commit message" });
    fireEvent.change(editor, { target: { value: "keep this draft" } });
    fireEvent.click(screen.getByRole("button", { name: "Hide commit" }));

    expect(
      document.querySelector<HTMLTextAreaElement>(
        "textarea[aria-label='Commit message']",
      ),
    ).toBe(editor);
    expect(editor.value).toBe("keep this draft");
    expect(
      editor.closest<HTMLElement>("[data-vcs-pane-content]")?.style.display,
    ).toBe("none");
    fireEvent.click(screen.getByRole("button", { name: "Show commit" }));
    expect(editor.value).toBe("keep this draft");
  });

  it("temporarily folds detail then navigation on narrow widths and restores them without changing saved preferences", () => {
    const changed = vi.fn();
    const { container } = render(<LayoutHarness onLayoutChange={changed} />);
    setWorkspaceWidth(900);
    expect(
      container.querySelector<HTMLElement>("[data-vcs-pane=detail]")?.style
        .width,
    ).toBe("28px");
    expect(
      container.querySelector<HTMLElement>("[data-vcs-pane=navigation]")?.style
        .width,
    ).toBe("180px");
    setWorkspaceWidth(700);
    expect(
      container.querySelector<HTMLElement>("[data-vcs-pane=navigation]")?.style
        .width,
    ).toBe("28px");
    expect(changed).not.toHaveBeenCalled();

    setWorkspaceWidth(1200);
    expect(
      container.querySelector<HTMLElement>("[data-vcs-pane=detail]")?.style
        .width,
    ).toBe("280px");
    expect(
      container.querySelector<HTMLElement>("[data-vcs-pane=navigation]")?.style
        .width,
    ).toBe("180px");
  });

  it("preserves a manually folded preference when the window becomes wide again", () => {
    render(<LayoutHarness />);
    fireEvent.click(screen.getByRole("button", { name: "Hide details" }));
    setWorkspaceWidth(1200);
    const detail = document.querySelector<HTMLElement>(
      "[data-vcs-pane=detail]",
    );
    expect(detail?.style.width).toBe("28px");
    expect(screen.getByRole("button", { name: "Show details" })).toBeTruthy();
  });

  it("imperatively reveals and focuses the commit editor without resetting history", () => {
    const layoutRef = createRef<VcsHistoryLayoutHandle>();
    render(
      <LayoutHarness
        layoutRef={layoutRef}
        initial={{
          ...defaults,
          collapsed: { ...defaults.collapsed, commit: true },
        }}
      />,
    );
    const editor = document.querySelector<HTMLTextAreaElement>(
      "textarea[aria-label='Commit message']",
    );
    if (!editor) throw new Error("commit editor was not rendered");
    expect(
      editor.closest<HTMLElement>("[data-vcs-pane-content]")?.style.display,
    ).toBe("none");

    act(() => layoutRef.current?.revealCommit());
    expect(
      editor.closest<HTMLElement>("[data-vcs-pane-content]")?.style.display,
    ).toBe("flex");
    expect(document.activeElement).toBe(editor);
  });
});
