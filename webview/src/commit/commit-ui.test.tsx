import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CvsHistory } from "../panel/components/CvsHistory";
import { initializeI18n } from "../shared/i18n";
import { useCommitStore } from "../shared/store/commit-store";
import { useRepositoryStore } from "../shared/store/repository-store";
import { CommitApp } from "./App";
import { ChangeTree } from "./components/ChangeTree";

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
vi.mock("../panel/utils/file-icons", () => ({ IconFolder: () => <svg /> }));
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
    unsyncedCvsCount: 0,
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
      view.getByText("app.txt", { selector: ".commit-file-name" }),
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

describe("D1 narrow local changes", () => {
  it("shows title, count, refresh, commit, rollback and more without preview", async () => {
    const view = render(<CommitApp />);
    act(() => mocks.resize(290));
    const header = view.container.querySelector(".changes-narrow-header");
    expect(header).not.toBeNull();
    expect(header?.textContent).toContain("Local Changes");
    expect(header?.textContent).toContain("2");
    expect(
      [...header!.querySelectorAll("button")].map((b) =>
        b.getAttribute("aria-label"),
      ),
    ).toEqual([
      "Refresh",
      "Commit...",
      "Rollback",
      "More Actions",
      "Hide Panel",
    ]);
    expect(view.container.querySelector(".diff-preview")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Commit..." }));
    expect(view.container.querySelector(".changes-commit")).not.toBeNull();
    expect(
      view.container.querySelectorAll('input[type="checkbox"]').length,
    ).toBeGreaterThan(0);
    fireEvent.click(view.getByRole("button", { name: "Hide Panel" }));
    expect(mocks.request).toHaveBeenCalledWith("collapseLocalChanges");
    fireEvent.click(view.getByRole("button", { name: "More Actions" }));
    expect(view.getByRole("button", { name: "Update Project" })).toBeTruthy();
  });
});

describe("大变更树", () => {
  it("只挂载视口行，滚动和 End/ArrowUp 能抵达未挂载文件", async () => {
    const many = Array.from({ length: 1000 }, (_, i) => ({
      repositoryId: "a",
      path: `file-${String(i).padStart(5, "0")}.txt`,
      status: "modified" as const,
      staged: false,
    }));
    useRepositoryStore.setState({
      repositories: [repositories[0]],
      snapshots: [{ repositoryId: "a", files: many }],
    });
    const view = render(<ChangeTree onSelect={() => {}} />);
    expect(view.getByText("file-00000.txt")).toBeTruthy();
    expect(
      view.container.querySelectorAll(".changes-file-row").length,
    ).toBeLessThan(80);
    const tree = view.getByLabelText("Changed Files");
    fireEvent.keyDown(tree, { key: "End" });
    fireEvent.keyDown(tree, { key: "ArrowUp" });
    fireEvent.keyDown(tree, { key: "ArrowUp" });
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain("file-00999.txt"),
    );
    fireEvent.keyDown(tree, { key: "Home" });
    await waitFor(() =>
      expect(document.activeElement?.textContent).toContain("Changes"),
    );
    Object.defineProperty(tree, "scrollTop", {
      configurable: true,
      value: 10000,
      writable: true,
    });
    fireEvent.scroll(tree);
    await waitFor(() => expect(view.getByText("file-00500.txt")).toBeTruthy());
    expect(view.queryByText("file-00000.txt")).toBeNull();
    expect(
      view.container.querySelectorAll(".changes-file-row").length,
    ).toBeLessThan(80);
  });
});

it("快照增量更新保留其它仓库、说明与勾选，通知不重新请求全部数据", async () => {
  useCommitStore.setState({
    selectedFiles: new Set(['["b","src/cvs.txt"]']),
    commitMessage: "保留说明",
  });
  const view = render(<ChangeTree onSelect={() => {}} />);
  mocks.request.mockClear();
  act(() => {
    for (const receive of mocks.events)
      receive("repositorySnapshotDelta", {
        repositoryId: "a",
        changed: [{ ...files[0], path: "replacement.txt" }],
        removed: ['["a","app.txt"]'],
      });
  });
  expect(view.queryByText("app.txt")).toBeNull();
  expect(view.getByText("replacement.txt")).toBeTruthy();
  expect(view.getByText("cvs.txt")).toBeTruthy();
  expect(
    useCommitStore.getState().selectedFiles.has('["b","src/cvs.txt"]'),
  ).toBe(true);
  expect(useCommitStore.getState().commitMessage).toBe("保留说明");
  expect(
    mocks.request.mock.calls.some(
      ([command]) => command === "getRepositoryChanges",
    ),
  ).toBe(false);
});

it("CVS 历史挂载和编辑器跟随不联网，显式选文件与打开历史才查询", async () => {
  mocks.request.mockImplementation(async (command) =>
    command === "getCvsFiles" ? ["app.txt", "other.txt"] : [],
  );
  const view = render(<CvsHistory repositoryId="b" activeFile="app.txt" />);
  await waitFor(() =>
    expect(view.getByRole("combobox").textContent).toContain("other.txt"),
  );
  expect(
    mocks.request.mock.calls.some(([command]) => command === "getCvsHistory"),
  ).toBe(false);
  view.rerender(<CvsHistory repositoryId="b" activeFile="other.txt" />);
  await waitFor(() =>
    expect((view.getByRole("combobox") as HTMLSelectElement).value).toBe(
      "other.txt",
    ),
  );
  expect(
    mocks.request.mock.calls.some(([command]) => command === "getCvsHistory"),
  ).toBe(false);
  fireEvent.change(view.getByRole("combobox"), {
    target: { value: "app.txt" },
  });
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith("getCvsHistory", {
      repositoryId: "b",
      filePath: "app.txt",
    }),
  );
  mocks.request.mockClear();
  view.rerender(
    <CvsHistory repositoryId="b" activeFile="other.txt" requestId={1} />,
  );
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith("getCvsHistory", {
      repositoryId: "b",
      filePath: "other.txt",
    }),
  );
});

it("仓库按自然名称排序，所有文件保留图标槽，长文件名使用剩余空间", async () => {
  const repos = ["cvs-10", "cvs-2", "cvs-01"].map((name) => ({
    id: name,
    kind: "cvs" as const,
    root: `/fixture/${name}`,
    name,
  }));
  useRepositoryStore.setState({
    repositories: repos,
    snapshots: repos.map((repo) => ({
      repositoryId: repo.id,
      files: [
        {
          repositoryId: repo.id,
          path: "app.txt",
          status: "modified" as const,
          staged: false,
        },
      ],
    })),
  });
  const view = render(<ChangeTree onSelect={() => {}} />);
  expect(
    [
      ...view.container.querySelectorAll(
        ".changes-row.repository .changes-row-label",
      ),
    ].map((n) => n.textContent),
  ).toEqual(["cvs-01", "cvs-2", "cvs-10"]);
  expect(view.container.querySelectorAll(".commit-file-icon").length).toBe(3);
});

it("宿主省略空字段时清除上一次历史请求，自动选仓不会重放旧意图", () => {
  useRepositoryStore.setState({
    historyRequest: { repositoryId: "b", sequence: 1 },
    activeFile: "old.txt",
  });
  act(() => {
    for (const receive of mocks.events)
      receive("repositoryList", { repositories, logRepositoryId: "a" });
  });
  expect(useRepositoryStore.getState().historyRequest).toBeUndefined();
  expect(useRepositoryStore.getState().activeFile).toBeUndefined();
});

describe("CVS 按需同步", () => {
  beforeEach(() => initializeI18n("zh-cn"));
  afterEach(() => initializeI18n("en"));
  it("显示未同步计数，归零不渲染，纯 CVS 工作区仍显示提示", async () => {
    useRepositoryStore.setState({ unsyncedCvsCount: 3 });
    const view = render(<CommitApp />);
    expect(
      await view.findByText("另有 3 个 CVS 仓库未同步，右键「与资源库同步」"),
    ).toBeTruthy();
    act(() => useRepositoryStore.setState({ unsyncedCvsCount: 0 }));
    expect(view.queryByText(/另有 .* 个 CVS 仓库未同步/)).toBeNull();
    act(() =>
      useRepositoryStore.setState({
        repositories: [],
        snapshots: [],
        unsyncedCvsCount: 2,
      }),
    );
    expect(
      await view.findByText("另有 2 个 CVS 仓库未同步，右键「与资源库同步」"),
    ).toBeTruthy();
    expect(view.queryByText("此工作区没有 Git 或 CVS 仓库。")).toBeNull();
  });
  it("CVS 行在分支后显示同步时间并通过已有 bridge 移除，干净仓库也保留行", async () => {
    useRepositoryStore.setState({
      repositories: [
        {
          ...repositories[1],
          syncedAt: new Date(2026, 10, 3, 14, 32).getTime(),
        },
      ],
      snapshots: [{ repositoryId: "b", files: [], branch: "GWH_R2_BRANCH" }],
    });
    const view = render(<ChangeTree onSelect={() => {}} />);
    expect(await view.findByText("同步于 14:32")).toBeTruthy();
    expect(view.getByText("GWH_R2_BRANCH")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "从同步中移除" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        "removeSynchronizedRepository",
        { repositoryId: "b" },
      ),
    );
  });
});
