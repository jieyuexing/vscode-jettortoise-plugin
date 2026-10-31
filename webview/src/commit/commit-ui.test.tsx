import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useCommitStore } from "../shared/store/commit-store";
import { useRepositoryStore } from "../shared/store/repository-store";
import { CommitApp } from "./App";

const mocks = vi.hoisted(() => ({
  request: vi.fn(),
  events: [] as ((event: string, data: unknown) => void)[],
  resize: (_width: number) => {},
}));
vi.mock("../shared/bridge", () => ({
  bridge: {
    request: mocks.request,
    onEvent: (fn: (event: string, data: unknown) => void) => {
      mocks.events.push(fn);
      return () => {};
    },
  },
}));
vi.mock("./utils/file-icon", () => ({
  getCommitFileIcon: () => () => <svg />,
}));
vi.mock("./components/IdeaShelfTab", () => ({ IdeaShelfTab: () => null }));
vi.mock("./components/ShelfTab", () => ({ ShelfTab: () => null }));
const repositories = [
  { id: "a", kind: "git" as const, root: "/fixture/git", name: "git" },
  { id: "b", kind: "cvs" as const, root: "/fixture/cvs", name: "cvs" },
];
const files = [
  {
    repositoryId: "a",
    path: "app.txt",
    status: "modified" as const,
    staged: false,
  },
  {
    repositoryId: "b",
    path: "src/cvs.txt",
    status: "modified" as const,
    staged: false,
  },
];
const snapshots = repositories.map((repository) => ({
  repositoryId: repository.id,
  files: [
    ...files.filter((file) => file.repositoryId === repository.id),
    {
      repositoryId: repository.id,
      path: "new.txt",
      status: "untracked" as const,
      staged: false,
    },
  ],
}));
const workspace = () => useRepositoryStore.getState();
const select = async (id: string) => {
  useRepositoryStore.setState({ commitRepositoryId: id });
  return workspace();
};
beforeEach(() => {
  mocks.request.mockReset();
  mocks.request.mockImplementation(
    async (command: string, params: Record<string, unknown> = {}) => {
      if (["getRepositories", "getRepositoryChanges"].includes(command))
        return workspace();
      if (command === "selectRepository")
        return select(params.repositoryId as string);
      if (command === "getWorkingFilePreview")
        return {
          left: { revision: "BASE" },
          leftContent: { available: true, text: "base\n" },
          rightContent: { available: true, text: "working\n" },
        };
      return [];
    },
  );
  vi.stubGlobal(
    "ResizeObserver",
    class {
      constructor(callback: (entries: unknown[]) => void) {
        mocks.resize = (width) => callback([{ contentRect: { width } }]);
      }
      observe() {
        mocks.resize(1600);
      }
      disconnect() {}
    },
  );
  HTMLElement.prototype.scrollIntoView = vi.fn();
  useRepositoryStore.setState({
    repositories,
    snapshots,
    commitRepositoryId: "a",
    logRepositoryId: "a",
    select: async (id) => {
      await select(id);
    },
  });
  useCommitStore.setState({
    activeTab: "commit",
    changes: files,
    selectedFiles: new Set(),
    highlightedFiles: new Set(),
    expandedGroups: new Set(["changes"]),
    collapsedDirs: new Set(),
    commitMessage: "",
    amend: false,
    error: undefined,
    loading: false,
    commitMode: false,
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe("本地更改三态", () => {
  it("浏览态没有提交表单与复选框，点击只预览、双击打开完整差异", async () => {
    const view = render(<CommitApp />);
    await waitFor(() => expect(view.getByText("app.txt")).toBeTruthy());
    expect(view.queryByRole("textbox")).toBeNull();
    expect(view.queryByRole("checkbox")).toBeNull();
    mocks.request.mockClear();
    fireEvent.click(view.getByText("app.txt"));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        "getWorkingFilePreview",
        expect.objectContaining({ filePath: "app.txt" }),
      ),
    );
    expect(
      mocks.request.mock.calls.some(
        ([command]) => command === "showDiffForWorkingFile",
      ),
    ).toBe(false);
    fireEvent.doubleClick(
      view.container.querySelector(".changes-tree .commit-file-name")!,
    );
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        "showDiffForWorkingFile",
        expect.objectContaining({ filePath: "app.txt" }),
      ),
    );
  });

  it("提交态内联展开，预选全部更改，Esc 保留说明并返回浏览", async () => {
    const view = render(<CommitApp />);
    await waitFor(() => expect(view.getByText("app.txt")).toBeTruthy());
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    const input = view.getByRole("textbox");
    expect(document.activeElement).toBe(input);
    expect(view.container.querySelector("dialog")).toBeNull();
    expect(useCommitStore.getState().selectedFiles.size).toBe(2);
    expect(
      view.container.querySelector(".changes-tree-pane")?.contains(input),
    ).toBe(true);
    expect(view.getByRole("region", { name: "Diff Preview" })).toBeTruthy();
    fireEvent.change(input, { target: { value: "修正说明" } });
    fireEvent.keyDown(window, { key: "Escape" });
    expect(view.queryByRole("textbox")).toBeNull();
    expect(useCommitStore.getState().commitMessage).toBe("修正说明");
    expect(
      mocks.request.mock.calls.some(
        ([command]) => command === "commitRepositories",
      ),
    ).toBe(false);
  });
  it("提交成功退出，失败保留说明与勾选，不混入未管理文件", async () => {
    const view = render(<CommitApp />);
    await waitFor(() => expect(view.getByText("app.txt")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Commit..." }));
    fireEvent.change(view.getByRole("textbox"), { target: { value: "说明" } });
    mocks.request.mockRejectedValueOnce(new Error("fixture failure"));
    fireEvent.click(view.getByRole("button", { name: "Commit", exact: true }));
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain("fixture failure"),
    );
    expect(view.getByRole("textbox")).toBeTruthy();
    expect(useCommitStore.getState().selectedFiles.size).toBe(2);
    fireEvent.click(view.getByRole("button", { name: "Commit", exact: true }));
    await waitFor(() => expect(view.queryByRole("textbox")).toBeNull());
    const payload = mocks.request.mock.calls.find(
      ([command]) => command === "commitRepositories",
    )?.[1];
    expect(payload.files).toHaveLength(2);
    expect(
      payload.files.every((file: { path: string }) => file.path !== "new.txt"),
    ).toBe(true);
  });
  it("没有仓库只显示一行空态，CVS 不显示 Git 页签与推送", async () => {
    useRepositoryStore.setState({ repositories: [], snapshots: [] });
    const empty = render(<CommitApp />);
    expect(empty.queryByRole("toolbar")).toBeNull();
    expect(empty.queryByRole("tablist")).toBeNull();
    expect(empty.container.textContent).toBe(
      "No Git or CVS repositories found in this workspace.",
    );
    empty.unmount();
    useRepositoryStore.setState({
      repositories: [repositories[1]],
      snapshots: [snapshots[1]],
      commitRepositoryId: "b",
    });
    const cvs = render(<CommitApp />);
    await waitFor(() => expect(cvs.getByText("cvs.txt")).toBeTruthy());
    expect(cvs.queryByRole("tablist")).toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(
      cvs.queryByRole("button", { name: "Commit and Push..." }),
    ).toBeNull();
  });
  it("窄栏隐藏预览，表单留在树下，切回宽栏仍能预览", async () => {
    const view = render(<CommitApp />);
    await waitFor(() => expect(view.getByText("app.txt")).toBeTruthy());
    act(() => mocks.resize(320));
    expect(view.queryByRole("region", { name: "Diff Preview" })).toBeNull();
    fireEvent.keyDown(window, { key: "k", ctrlKey: true });
    expect(view.getByRole("textbox")).toBeTruthy();
    act(() => mocks.resize(1600));
    expect(view.getByRole("region", { name: "Diff Preview" })).toBeTruthy();
  });
  it("过时预览不覆盖后选文件，统一视图只读，有界大文件显示提示", async () => {
    let resolveOld: (value: unknown) => void = () => {};
    mocks.request.mockImplementation(
      async (command: string, params: Record<string, unknown> = {}) => {
        if (["getRepositories", "getRepositoryChanges"].includes(command))
          return workspace();
        if (command === "getWorkingFilePreview") {
          if (params.filePath === "app.txt")
            return new Promise((resolve) => {
              resolveOld = resolve;
            });
          return {
            kind: "cvs",
            left: { revision: "1.1" },
            leftContent: { available: false, reason: "tooLarge" },
            rightContent: { available: true, text: "working" },
          };
        }
        return [];
      },
    );
    const view = render(<CommitApp />);
    await waitFor(() => expect(view.getByText("app.txt")).toBeTruthy());
    fireEvent.click(view.getByText("app.txt"));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        "getWorkingFilePreview",
        expect.objectContaining({ filePath: "app.txt" }),
      ),
    );
    fireEvent.click(view.getByText("cvs.txt"));
    await waitFor(() =>
      expect(view.getByText(/Preview unavailable/)).toBeTruthy(),
    );
    await act(async () =>
      resolveOld({
        left: { revision: "HEAD" },
        leftContent: { available: true, text: "old" },
        rightContent: { available: true, text: "stale" },
      }),
    );
    expect(view.queryByText("stale")).toBeNull();
    expect(view.queryByRole("textbox")).toBeNull();
  });

  it("并排和统一视图可导航，中缝只打开完整差异", async () => {
    const view = render(<CommitApp />);
    await waitFor(() => expect(view.getByText("app.txt")).toBeTruthy());
    const item = view.getByText("app.txt");
    fireEvent.click(item);
    await waitFor(() => expect(view.getByText("working")).toBeTruthy());
    expect(view.container.querySelectorAll(".diff-cell.modified")).toHaveLength(
      2,
    );
    fireEvent.click(view.getByRole("button", { name: "Unified", exact: true }));
    expect(
      view.container.querySelector(".diff-preview-body.unified"),
    ).toBeTruthy();
    fireEvent.click(
      view.getByRole("button", { name: "Side by Side", exact: true }),
    );
    fireEvent.click(view.getByRole("button", { name: "Next Difference" }));
    fireEvent.click(
      view.getByRole("button", {
        name: "Rollback this change in the full diff",
      }),
    );
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        "showDiffForWorkingFile",
        expect.objectContaining({ filePath: "app.txt" }),
      ),
    );
    expect(
      mocks.request.mock.calls.some(([command]) =>
        ["rollbackFile", "commitRepositories"].includes(command),
      ),
    ).toBe(false);
  });
  it("宿主页签已有标题，树顶部只显示小页签", async () => {
    const view = render(<CommitApp />);
    await waitFor(() => expect(view.getByText("app.txt")).toBeTruthy());
    expect(view.container.querySelector(".panel-header-title")).toBeNull();
    expect(view.getByRole("tab", { name: "Changes" })).toBeTruthy();
  });
});
