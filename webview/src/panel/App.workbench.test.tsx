import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  events: [] as Array<(event: string, data: unknown) => void>,
  graphReject: undefined as undefined | ((error: Error) => void),
  request: vi.fn(),
  changes: [{ path: "working.ts", status: "modified", staged: false }],
}));
vi.mock("../shared/bridge/vscode-api", () => ({
  getVSCodeApi: () => ({ postMessage() {}, getState() {}, setState() {} }),
}));
vi.mock("../shared/hooks/useShiki", () => ({ useShiki: () => null }));
vi.mock("../shared/bridge", () => ({
  bridge: {
    request: fixture.request,
    onEvent: (listener: (event: string, data: unknown) => void) => {
      fixture.events.push(listener);
      return () => {
        fixture.events = fixture.events.filter((item) => item !== listener);
      };
    },
  },
}));
vi.mock("./components/BranchTree", () => ({
  BranchTree: ({ onTogglePanel }: { onTogglePanel: () => void }) => (
    <button onClick={onTogglePanel}>Hide navigation</button>
  ),
}));
vi.mock("./components/Toolbar", () => ({
  Toolbar: () => <input aria-label="Search history" />,
}));
vi.mock("./components/GitGraphPanel", () => ({
  GitGraphPanel: () => <div>History rows</div>,
}));
vi.mock("./components/DetailPanel", () => ({
  DetailPanel: () => <div>Historical files and revision details</div>,
}));

import { initializeI18n } from "../shared/i18n";
import { useCommitStore } from "../shared/store/commit-store";
import { usePanelStore } from "../shared/store/panel-store";
import { useWorkbenchStore } from "../shared/store/workbench-store";
import { PanelApp } from "./App";

function messageInput() {
  return screen.getByPlaceholderText(
    "Commit message (Ctrl+Enter to commit)",
  ) as HTMLTextAreaElement;
}
function broadcast(event: string, data = {}) {
  act(() => {
    for (const listener of [...fixture.events]) listener(event, data);
  });
}

describe("integrated Git workbench", () => {
  beforeEach(() => {
    initializeI18n("en");
    fixture.request.mockReset().mockImplementation((command: string) => {
      if (command === "getGraphData")
        return new Promise((_resolve, reject) => {
          fixture.graphReject = reject;
        });
      if (command === "getWorkingTreeChanges")
        return Promise.resolve(fixture.changes);
      if (command === "getRecentCommitMessages")
        return Promise.resolve(["prior message"]);
      return Promise.resolve([]);
    });
    useCommitStore.setState({
      ...useCommitStore.getInitialState(),
      changes: fixture.changes,
      selectedFiles: new Set(["working.ts:false"]),
    });
    usePanelStore.setState(usePanelStore.getInitialState());
    useWorkbenchStore.setState(useWorkbenchStore.getInitialState());
  });
  afterEach(() => {
    cleanup();
    vi.restoreAllMocks();
  });

  it("retains the full commit region and draft through slow or failed history and collapse", async () => {
    vi.spyOn(console, "error").mockImplementation(() => {});
    render(<PanelApp />);
    const input = messageInput();
    fireEvent.change(input, { target: { value: "draft survives" } });
    expect(screen.getByText("Loading...")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide Commit Area" }));
    expect(input.isConnected).toBe(true);
    act(() => {
      fixture.graphReject?.(new Error("fixture history failure"));
    });
    await waitFor(() => expect(usePanelStore.getState().loading).toBe(false));
    fireEvent.click(screen.getByRole("button", { name: "Show Commit Area" }));
    expect(messageInput()).toBe(input);
    expect(input.value).toBe("draft survives");
    expect(
      useCommitStore.getState().selectedFiles.has("working.ts:false"),
    ).toBe(true);
    expect(
      fixture.request.mock.calls.filter(
        ([command]) => command === "commitChanges",
      ),
    ).toHaveLength(0);
  });

  it("preserves drafts and selection across Shelf/Stash and focuses Commit without clearing history", async () => {
    render(<PanelApp />);
    fireEvent.change(messageInput(), { target: { value: "unfinished" } });
    fireEvent.click(screen.getByRole("button", { name: "Shelf", exact: true }));
    expect(useCommitStore.getState().activeTab).toBe("shelf");
    fireEvent.click(screen.getByRole("button", { name: "Stash", exact: true }));
    expect(useCommitStore.getState().activeTab).toBe("stash");
    act(() =>
      usePanelStore.setState({
        filter: { ...usePanelStore.getState().filter, file: "history.ts" },
        selectedFilePath: "historical-only.ts",
      }),
    );
    fireEvent.click(screen.getByRole("button", { name: "Hide Commit Area" }));
    broadcast("showCommitPanel");
    await waitFor(() => expect(document.activeElement).toBe(messageInput()));
    expect(messageInput().value).toBe("unfinished");
    expect(usePanelStore.getState().filter.file).toBe("history.ts");
    expect(
      useCommitStore.getState().selectedFiles.has("working.ts:false"),
    ).toBe(true);
    broadcast("gitStateChanged");
    await waitFor(() => expect(useCommitStore.getState().loading).toBe(false));
    expect(messageInput().value).toBe("unfinished");
  });

  it("only submits from the commit input shortcut and keeps the existing operation arguments", async () => {
    render(<PanelApp />);
    fireEvent.change(messageInput(), { target: { value: "local edit" } });
    await waitFor(() => expect(useCommitStore.getState().loading).toBe(false));
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Search history" }), {
      key: "Enter",
      ctrlKey: true,
    });
    expect(
      fixture.request.mock.calls.filter(
        ([command]) => command === "commitChanges",
      ),
    ).toHaveLength(0);
    fireEvent.keyDown(messageInput(), { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(fixture.request).toHaveBeenCalledWith("commitChanges", {
        message: "local edit",
        amend: false,
        filePaths: ["working.ts"],
      }),
    );
    expect(
      fixture.request.mock.calls.filter(
        ([command]) => command === "commitChanges",
      ),
    ).toHaveLength(1);
  });

  it("anchors recent messages to the commit column instead of the editor viewport", async () => {
    const rectangle = vi.spyOn(HTMLElement.prototype, "getBoundingClientRect");
    rectangle.mockImplementation(function (this: HTMLElement) {
      return {
        x: 70,
        y: 500,
        left: 70,
        top: 500,
        right: this.classList.contains("commit-app") ? 350 : 90,
        bottom: 620,
        width: this.classList.contains("commit-app") ? 280 : 20,
        height: 120,
        toJSON() {},
      };
    });
    render(<PanelApp />);
    fireEvent.click(
      screen.getByRole("button", { name: "Recent commit messages" }),
    );
    const item = await screen.findByText("prior message");
    const menu = item.parentElement as HTMLElement;
    expect(menu.style.left).toBe("74px");
    expect(menu.style.width).toBe("272px");
    expect(menu.style.right).toBe("");
    fireEvent.click(item);
    expect(messageInput().value).toBe("prior message");
  });
});
