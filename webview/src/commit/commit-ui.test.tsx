import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { PanelApp } from "../panel/App";
import { BranchTree } from "../panel/components/BranchTree";
import { CommitContextMenu } from "../panel/components/CommitContextMenu";
import { CvsHistory } from "../panel/components/CvsHistory";
import { PushApp } from "../push/App";
import { FileTree } from "../shared/components/FileTree";
import { initializeI18n } from "../shared/i18n";
import { useCommitStore } from "../shared/store/commit-store";
import { usePanelStore } from "../shared/store/panel-store";
import {
  commitTarget,
  useRepositoryStore,
} from "../shared/store/repository-store";
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
  bridgeWithProgress: (command: string, params?: Record<string, unknown>) =>
    mocks.request(command, params),
}));
vi.mock("../panel/utils/file-icons", () => ({
  IconFolder: () => <svg />,
  IconFolderOpen: () => <svg />,
  getFileIcon: () => () => <svg />,
}));
vi.mock("./utils/file-icon", () => ({
  getCommitFileIcon: () => () => <svg />,
}));
vi.mock("./components/IdeaShelfTab", () => ({ IdeaShelfTab: () => null }));
vi.mock("./components/ShelfTab", () => ({ ShelfTab: () => null }));
// 导入时（store 等模块级订阅）已登记的事件监听；其后组件登记的监听由用例自行清理。
const moduleEvents = mocks.events.length;
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
    logRepositories: undefined,
    visible: true,
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
  it("首次摘要尚无文件时也显示仓库行与加载计数", () => {
    initializeI18n("zh-cn");
    useRepositoryStore.setState({
      repositories: [repositories[0]],
      snapshots: [{ repositoryId: "a", files: [], refreshing: true }],
    });
    const view = render(<ChangeTree onSelect={() => {}} />);
    const row = view.container.querySelector(".changes-row.repository");
    expect(row?.querySelector(".changes-row-label")?.textContent).toBe("git");
    expect(row?.querySelector(".changes-count")?.textContent).toBe("正在加载…");
    initializeI18n("en");
  });
  it.each(
    repositories,
  )("$kind 首屏及分批加载只在仓库行显示状态，树行均有明确类型", (repository) => {
    initializeI18n("zh-cn");
    try {
      useRepositoryStore.setState({
        repositories: [repository],
        snapshots: [
          { repositoryId: repository.id, files: [], refreshing: true },
        ],
      });
      const view = render(<ChangeTree onSelect={() => {}} />);
      const assertRows = () => {
        const rows = [
          ...view.container.querySelectorAll(".changes-tree [data-row-index]"),
        ];
        expect(rows.length).toBeGreaterThan(0);
        expect(
          rows
            .filter(
              (row) =>
                !row.querySelector(
                  ":scope > .changes-row.category, :scope > .changes-row.repository, :scope > .changes-file-row",
                ),
            )
            .map((row) => row.textContent),
        ).toEqual([]);
        const loading = view.getAllByText(/正在加载…/);
        expect(loading).toHaveLength(1);
        expect(loading[0].closest(".changes-row.repository")).toBeTruthy();
      };
      assertRows();
      const partial = [{ ...files[0], repositoryId: repository.id }];
      act(() =>
        useRepositoryStore.setState({
          snapshots: [
            { repositoryId: repository.id, files: partial, refreshing: true },
          ],
        }),
      );
      assertRows();
      expect(
        view.container.querySelector(".changes-row.repository .changes-count")
          ?.textContent,
      ).toBe("正在加载… 1 个文件");
      act(() =>
        useRepositoryStore.setState({
          snapshots: [
            { repositoryId: repository.id, files: partial, refreshing: false },
          ],
        }),
      );
      expect(view.queryByText(/正在加载…/)).toBeNull();
      expect(
        view.container.querySelector(".changes-row.repository .changes-count")
          ?.textContent,
      ).toBe("1 个文件");
    } finally {
      initializeI18n("en");
    }
  });
  it("干净暂停仓仍显示行内状态和扫描按钮，点击只发送登记仓的本地扫描请求", async () => {
    initializeI18n("zh-cn");
    useRepositoryStore.setState({
      repositories: [repositories[0]],
      snapshots: [{ repositoryId: "a", files: [], scanPaused: true }],
    });
    const view = render(<ChangeTree onSelect={() => {}} />);
    const status = view.getByText("仓库较大，已暂停自动扫描");
    const scanLabel = "仓库较大，已暂停自动扫描；点击继续扫描";
    const button = view.getByRole("button", { name: scanLabel });
    expect(button.title).toBe(scanLabel);
    expect(status.closest(".changes-row")).toBe(button.closest(".changes-row"));
    mocks.request.mockClear();
    fireEvent.click(button);
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("scanRepository", {
        repositoryId: "a",
      }),
    );
    expect(mocks.request.mock.calls).toHaveLength(1);
    act(() =>
      useRepositoryStore.setState({
        snapshots: [{ repositoryId: "a", files: [] }],
      }),
    );
    expect(view.queryByRole("button", { name: scanLabel })).toBeNull();
    initializeI18n("en");
  });
  it("暂停仓按名称、标签、分支、同步时间、计数、状态排列，扫描与移除位于行尾", () => {
    useRepositoryStore.setState({
      repositories: [{ ...repositories[1], syncedAt: Date.now() }],
      snapshots: [
        {
          repositoryId: "b",
          files: [],
          branch: "feature-rework",
          scanPaused: true,
        },
      ],
    });
    const view = render(<ChangeTree onSelect={() => {}} />);
    const row = view.container.querySelector(".changes-row.repository")!;
    expect(
      Array.from(row.children).map((element) => element.className),
    ).toEqual([
      "changes-twisty",
      "changes-row-label",
      "changes-tag",
      "changes-branch",
      "changes-synced-at",
      "changes-count",
      "changes-scan-status",
      "changes-actions",
    ]);
    expect(
      Array.from(row.querySelector(".changes-actions")!.children).map(
        (element) => element.className,
      ),
    ).toEqual([
      expect.stringContaining("changes-scan"),
      expect.stringContaining("changes-remove-sync"),
    ]);
  });
  it.each([
    170, 220, 300,
  ])("%ipx 暂停仓按序让位，名称至少一字加省略号，扫描保持 22px", (width) => {
    // jsdom 没有排版引擎；固定字体量值覆盖让位逻辑，实际像素另由 Electron CDP 验证。
    const nativeStyle = getComputedStyle;
    vi.stubGlobal("getComputedStyle", (element: Element) => ({
      ...nativeStyle(element),
      columnGap: "5px",
      paddingLeft: "24px",
      paddingRight: "8px",
      marginLeft: "0px",
      marginRight: "0px",
      font: "12px sans-serif",
      fontSize: "12px",
      getPropertyValue: (name: string) =>
        nativeStyle(element).getPropertyValue(name),
    }));
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      measureText: (text: string) => ({ width: text === "…" ? 12 : 6 }),
    } as unknown as CanvasRenderingContext2D);
    const natural: Record<string, number> = {
      "changes-twisty": 14,
      "changes-row-label": 48,
      "changes-tag": 26,
      "changes-branch": 84,
      "changes-synced-at": 84,
      "changes-count": 48,
      "changes-scan-status": 156,
      "changes-actions": 43,
      "changes-scan": 22,
      "changes-remove-sync": 16,
    };
    const measuredWidth = (element: HTMLElement) => {
      if (element.style.display === "none") return 0;
      if (element.style.width) return Number.parseFloat(element.style.width);
      if (element.matches(".changes-tree,.changes-row")) return width - 6;
      return (
        natural[
          Array.from(element.classList).find((name) => name in natural) ?? ""
        ] ?? 0
      );
    };
    vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(
      function () {
        return new DOMRect(0, 0, measuredWidth(this), 20);
      },
    );
    vi.spyOn(HTMLElement.prototype, "clientWidth", "get").mockImplementation(
      function () {
        return measuredWidth(this);
      },
    );
    try {
      useRepositoryStore.setState({
        repositories: [{ ...repositories[1], syncedAt: Date.now() }],
        snapshots: [
          {
            repositoryId: "b",
            files: [],
            branch: "feature-rework",
            scanPaused: true,
          },
        ],
      });
      const view = render(<ChangeTree onSelect={() => {}} />);
      const row = view.container.querySelector<HTMLElement>(
        ".changes-row.repository",
      )!;
      expect(
        row.querySelector<HTMLElement>(".changes-row-label")!.clientWidth,
      ).toBeGreaterThanOrEqual(24);
      expect(row.querySelector<HTMLElement>(".changes-scan")!.clientWidth).toBe(
        22,
      );
      expect(row.querySelector<HTMLElement>(".changes-tag")!.clientWidth).toBe(
        26,
      );
      for (const selector of [
        ".changes-branch",
        ".changes-synced-at",
        ".changes-count",
      ])
        expect(row.querySelector<HTMLElement>(selector)!.clientWidth).toBe(0);
      const statusWidth = row.querySelector<HTMLElement>(
        ".changes-scan-status",
      )!.clientWidth;
      if (width === 170) expect(statusWidth).toBe(0);
      else expect(statusWidth).toBeGreaterThanOrEqual(24);
    } finally {
      vi.restoreAllMocks();
    }
  });
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
  it("170px 标题只保留更多与收起，三个主要动作仍可从更多执行", async () => {
    const view = render(<CommitApp />);
    act(() => mocks.resize(170));
    const header = view.container.querySelector(".changes-narrow-header")!;
    const toolbar = header.querySelector('[role="toolbar"]')!;
    expect(
      [...toolbar.querySelectorAll("button")].map((b) =>
        b.getAttribute("aria-label"),
      ),
    ).toEqual(["More Actions", "Hide Panel"]);
    fireEvent.click(view.getByRole("button", { name: "More Actions" }));
    const more = header.querySelector(".changes-more-actions")!;
    expect(more.querySelector('[aria-label="Refresh"]')).not.toBeNull();
    expect(more.querySelector('[aria-label="Rollback"]')).not.toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("refreshRepositories"),
    );
    fireEvent.click(view.getByRole("button", { name: "Commit..." }));
    expect(view.container.querySelector(".changes-commit")).not.toBeNull();
    act(() => mocks.resize(300));
    expect(toolbar.querySelector('[aria-label="Refresh"]')).not.toBeNull();
  });

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

it("CVS 暂停时历史不重新盘点，恢复后读清单并查询首个文件历史", async () => {
  useRepositoryStore.setState({
    snapshots: [{ repositoryId: "b", files: [], scanPaused: true }],
  });
  mocks.request.mockImplementation(async (command) =>
    command === "getCvsFiles" ? ["app.txt"] : [],
  );
  const view = render(<CvsHistory repositoryId="b" />);
  expect(mocks.request).not.toHaveBeenCalled();
  act(() =>
    useRepositoryStore.setState({
      snapshots: [{ repositoryId: "b", files: [] }],
    }),
  );
  await waitFor(() =>
    expect(view.getByRole("combobox").textContent).toContain("app.txt"),
  );
  await waitFor(() =>
    expect(mocks.request).toHaveBeenCalledWith("getCvsHistory", {
      repositoryId: "b",
      filePath: "app.txt",
    }),
  );
  expect(
    mocks.request.mock.calls.every(([command]) =>
      ["getCvsFiles", "getCvsHistory"].includes(command),
    ),
  ).toBe(true);
});

const historyCalls = () =>
  mocks.request.mock.calls
    .filter(([command]) => command === "getCvsHistory")
    .map(([, params]) => (params as { filePath: string }).filePath);

it("CVS 历史挂载按当前或首个文件查询，日志隐藏时等到可见再查", async () => {
  mocks.request.mockImplementation(async (command) =>
    command === "getCvsFiles"
      ? ["app.txt", "other.txt"]
      : command === "getCvsHistory"
        ? [
            {
              revisionId: "1.2",
              timestamp: "2026-11-10",
              author: { name: "fixture" },
              subject: "second",
              body: "second",
            },
          ]
        : [],
  );
  const view = render(<CvsHistory repositoryId="b" activeFile="other.txt" />);
  await waitFor(() => expect(view.getByText("1.2")).toBeTruthy());
  expect(historyCalls()).toEqual(["other.txt"]);
  mocks.request.mockClear();
  view.rerender(<CvsHistory repositoryId="b" />);
  await waitFor(() => expect(historyCalls()).toEqual(["other.txt"]));
  act(() => useRepositoryStore.setState({ visible: false }));
  mocks.request.mockClear();
  view.rerender(<CvsHistory repositoryId="b" activeFile="app.txt" />);
  await waitFor(() =>
    expect((view.getByRole("combobox") as HTMLSelectElement).value).toBe(
      "app.txt",
    ),
  );
  expect(historyCalls()).toEqual([]);
  act(() => useRepositoryStore.setState({ visible: true }));
  await waitFor(() => expect(historyCalls()).toEqual(["app.txt"]));
  mocks.request.mockClear();
  fireEvent.change(view.getByRole("combobox"), {
    target: { value: "other.txt" },
  });
  await waitFor(() => expect(historyCalls()).toEqual(["other.txt"]));
});

it("显式打开历史只查询一次", async () => {
  mocks.request.mockImplementation(async (command) =>
    command === "getCvsFiles" ? ["app.txt", "other.txt"] : [],
  );
  const view = render(
    <CvsHistory repositoryId="b" activeFile="other.txt" requestId={3} />,
  );
  await waitFor(() => expect(historyCalls()).toEqual(["other.txt"]));
  await new Promise((resolve) => setTimeout(resolve, 50));
  expect(historyCalls()).toEqual(["other.txt"]);
  view.unmount();
});

const logRepository = {
  id: "c",
  kind: "cvs" as const,
  root: "/fixture/SampleWeb",
  name: "SampleWeb",
};
const logCommits = [
  {
    id: "k2",
    time: Date.parse("2026-10-28T12:02:00Z"),
    author: "dev-a",
    subject: "add the search filter",
    body: "",
    fileCount: 3,
  },
  {
    id: "k1",
    time: Date.parse("2026-10-21T12:15:00Z"),
    author: "dev-b",
    subject: "fix the report",
    body: "",
    fileCount: 1,
  },
];
const commitFiles: Record<string, unknown[]> = {
  k2: [
    {
      path: "src/Search.java",
      revision: "1.8",
      previous: "1.7",
      kind: "modified",
    },
    { path: "src/SearchForm.java", revision: "1.1", kind: "added" },
    { path: "src/Old.java", revision: "1.4", previous: "1.3", kind: "deleted" },
  ],
  k1: [
    {
      path: "src/Report.java",
      revision: "1.3",
      previous: "1.2",
      kind: "modified",
    },
  ],
};
const logCalls = () =>
  mocks.request.mock.calls.filter(([command]) =>
    ["getCvsLog", "getCvsCommit", "getCvsFiles", "getCvsHistory"].includes(
      command,
    ),
  );
function useCvsLog() {
  // 订阅表跨用例累积；只保留模块级监听与当前用例组件的监听。
  mocks.events.length = moduleEvents;
  useRepositoryStore.setState({
    repositories: [repositories[0]],
    logRepositories: [repositories[0], logRepository],
    snapshots: [snapshots[0]],
    logRepositoryId: "c",
    unsyncedCvsCount: 1,
  });
  mocks.request.mockImplementation(
    async (command: string, params: Record<string, unknown> = {}) => {
      if (command === "getRepositories") return workspace();
      if (command === "getCvsLog")
        return { commits: logCommits, days: params.days };
      if (command === "getCvsCommit")
        return commitFiles[params.commitId as string];
      if (command === "getCvsFiles")
        return ["src/Search.java", "src/Report.java"];
      if (command === "getCvsHistory")
        return [
          {
            revisionId: "1.7",
            timestamp: "2026-11-10",
            author: { name: "fixture" },
            subject: `history of ${params.filePath}`,
            body: "",
          },
        ];
      return [];
    },
  );
}

it("日志下拉列出未同步的 CVS 仓库，默认显示仓库级提交列表", async () => {
  useCvsLog();
  const view = render(<PanelApp />);
  const repository = view.getByLabelText("Repository") as HTMLSelectElement;
  expect([...repository.options].map((option) => option.value)).toEqual([
    "a",
    "c",
  ]);
  expect(repository.value).toBe("c");
  await waitFor(() =>
    expect(view.getAllByText("add the search filter").length).toBeGreaterThan(
      0,
    ),
  );
  expect(view.queryByText("No available repository.")).toBeNull();
  expect(mocks.request).toHaveBeenCalledWith("getCvsLog", {
    repositoryId: "c",
    days: 90,
  });
  // 先只读缓存（不连服务器），再取增量，然后取所选提交的文件。
  expect(mocks.request).toHaveBeenCalledWith("getCvsLog", {
    repositoryId: "c",
    days: 90,
    cached: true,
  });
  expect(logCalls().map(([command]) => command)).toEqual([
    "getCvsLog",
    "getCvsLog",
    "getCvsCommit",
  ]);
});

describe("CVS 仓库级日志", () => {
  beforeEach(() => useCvsLog());

  it("列出日期、作者、说明、文件数；选中一行右侧列出文件及修订变化，单击文件打开两修订差异", async () => {
    const view = render(<PanelApp />);
    await waitFor(() => expect(view.getByText("fix the report")).toBeTruthy());
    const row = view
      .getAllByText("add the search filter")[0]
      .closest('[role="row"]');
    expect(row?.textContent).toContain("dev-a");
    expect(row?.textContent).toContain("2026-10-28");
    expect(row?.textContent).toContain("3");
    // 默认选中最新一行，详情标题、作者与文件数。
    await waitFor(() => expect(view.getByText("1.7 → 1.8")).toBeTruthy());
    expect(view.getByText("New 1.1")).toBeTruthy();
    // 目录与文件名分开渲染，窄栏里目录先省略、文件名保持可见。
    expect(
      view.getByTitle("src/SearchForm.java").querySelector(".cvs-log-name")
        ?.textContent,
    ).toBe("SearchForm.java");
    expect(view.getByText("Deleted 1.4")).toBeTruthy();
    expect(view.getByTitle("src/SearchForm.java")).toBeTruthy();
    fireEvent.click(view.getByTitle("src/Search.java"));
    expect(mocks.request).toHaveBeenCalledWith("diffCvsRevision", {
      repositoryId: "c",
      filePath: "src/Search.java",
      revision: "1.8",
    });
    fireEvent.click(view.getByTitle("src/Old.java"));
    expect(mocks.request).toHaveBeenCalledWith("diffCvsRevision", {
      repositoryId: "c",
      filePath: "src/Old.java",
      revision: "1.4",
    });
    fireEvent.click(view.getByText("fix the report"));
    await waitFor(() => expect(view.getByText("1.2 → 1.3")).toBeTruthy());
    expect(mocks.request).toHaveBeenCalledWith("getCvsCommit", {
      repositoryId: "c",
      commitId: "k1",
    });
  });

  it("范围：默认近 90 天；全部、加载更早、刷新各向宿主请求一次", async () => {
    const view = render(<PanelApp />);
    await waitFor(() => expect(view.getByText("fix the report")).toBeTruthy());
    mocks.request.mockClear();
    fireEvent.click(view.getByRole("button", { name: "All" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("getCvsLog", {
        repositoryId: "c",
        days: 0,
      }),
    );
    expect(view.queryByText("Load earlier…")).toBeNull();
    fireEvent.click(view.getByRole("button", { name: "Last 90 days" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("getCvsLog", {
        repositoryId: "c",
        days: 90,
      }),
    );
    mocks.request.mockClear();
    fireEvent.click(await view.findByText("Load earlier…"));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("getCvsLog", {
        repositoryId: "c",
        days: 180,
      }),
    );
    await waitFor(() =>
      expect(view.getByRole("button", { name: "Last 180 days" })).toBeTruthy(),
    );
    mocks.request.mockClear();
    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("getCvsLog", {
        repositoryId: "c",
        days: 180,
        refresh: true,
      }),
    );
  });

  it("整个仓库模式下切换编辑器文件、写入通知都不再连服务器", async () => {
    const view = render(<PanelApp />);
    await waitFor(() => expect(view.getByText("fix the report")).toBeTruthy());
    await waitFor(() => expect(view.getByText("1.7 → 1.8")).toBeTruthy());
    mocks.request.mockClear();
    for (const file of ["src/Search.java", "src/Report.java", undefined])
      act(() => useRepositoryStore.setState({ activeFile: file }));
    act(() => {
      for (const listener of mocks.events)
        listener("repositoryWritten", { repositoryId: "c" });
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(logCalls()).toEqual([]);
  });

  it("日志隐藏时不取，可见后才取一次", async () => {
    act(() => useRepositoryStore.setState({ visible: false }));
    const view = render(<PanelApp />);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(logCalls()).toEqual([]);
    act(() => useRepositoryStore.setState({ visible: true }));
    await waitFor(() => expect(view.getByText("fix the report")).toBeTruthy());
    expect(
      logCalls().filter(
        ([command, params]) =>
          command === "getCvsLog" && !(params as { cached?: boolean }).cached,
      ),
    ).toHaveLength(1);
  });

  it("当前文件模式保留单文件历史，只有此模式下编辑器切换才更新它", async () => {
    const view = render(<PanelApp />);
    await waitFor(() => expect(view.getByText("fix the report")).toBeTruthy());
    mocks.request.mockClear();
    fireEvent.click(view.getByRole("button", { name: "Current file" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("getCvsFiles", {
        repositoryId: "c",
      }),
    );
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("getCvsHistory", {
        repositoryId: "c",
        filePath: "src/Search.java",
      }),
    );
    await waitFor(() =>
      expect(view.getByText("history of src/Search.java")).toBeTruthy(),
    );
    expect(
      mocks.request.mock.calls.some(([command]) => command === "getCvsLog"),
    ).toBe(false);
    mocks.request.mockClear();
    act(() => useRepositoryStore.setState({ activeFile: "src/Report.java" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("getCvsHistory", {
        repositoryId: "c",
        filePath: "src/Report.java",
      }),
    );
    // 回到整个仓库：列表来自宿主缓存的同一次请求，编辑器切换不再触发历史。
    fireEvent.click(view.getByRole("button", { name: "Whole repository" }));
    await waitFor(() => expect(view.getByText("fix the report")).toBeTruthy());
    mocks.request.mockClear();
    act(() => useRepositoryStore.setState({ activeFile: "src/Search.java" }));
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(
      mocks.request.mock.calls.filter(([command]) =>
        ["getCvsHistory", "getCvsFiles"].includes(command),
      ),
    ).toEqual([]);
  });

  it("显式显示文件历史切到当前文件模式；工程级打开历史留在整个仓库模式", async () => {
    act(() =>
      useRepositoryStore.setState({
        activeFile: "src/Report.java",
        historyRequest: { repositoryId: "c", sequence: 1 },
      }),
    );
    const file = render(<PanelApp />);
    await waitFor(() =>
      expect(file.getByText("history of src/Report.java")).toBeTruthy(),
    );
    expect(
      mocks.request.mock.calls.some(([command]) => command === "getCvsLog"),
    ).toBe(false);
    cleanup();
    mocks.request.mockClear();
    act(() =>
      useRepositoryStore.setState({
        activeFile: undefined,
        historyRequest: { repositoryId: "c", sequence: 2 },
      }),
    );
    const project = render(<PanelApp />);
    await waitFor(() =>
      expect(
        project.getAllByText("add the search filter").length,
      ).toBeGreaterThan(0),
    );
    expect(
      mocks.request.mock.calls.some(([command]) => command === "getCvsHistory"),
    ).toBe(false);
  });

  it("详情里的文件右键「显示该文件历史」切到当前文件并选中该文件", async () => {
    const view = render(<PanelApp />);
    await waitFor(() => expect(view.getByText("1.7 → 1.8")).toBeTruthy());
    mocks.request.mockClear();
    fireEvent.contextMenu(view.getByTitle("src/SearchForm.java"));
    fireEvent.click(view.getByText("Show history of this file"));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("getCvsHistory", {
        repositoryId: "c",
        filePath: "src/SearchForm.java",
      }),
    );
  });

  it("对 Git 文件显示历史不改变 CVS 的默认模式", async () => {
    // Git 仓库的显式显示历史（带文件）已经发生，随后日志选中 CVS 仓库。
    act(() =>
      useRepositoryStore.setState({
        activeFile: "app.txt",
        historyRequest: { repositoryId: "a", sequence: 1 },
      }),
    );
    const view = render(<PanelApp />);
    await waitFor(() => expect(view.getByText("fix the report")).toBeTruthy());
    const pressed = (name: string) =>
      view.getByRole("button", { name }).getAttribute("aria-pressed");
    expect(pressed("Whole repository")).toBe("true");
    // 用户切到当前文件后，又来一个 Git 请求，同样不改 CVS 的模式。
    fireEvent.click(view.getByRole("button", { name: "Current file" }));
    act(() =>
      useRepositoryStore.setState({
        historyRequest: { repositoryId: "a", sequence: 2 },
      }),
    );
    expect(pressed("Current file")).toBe("true");
  });

  it("右键选的文件只对当次有效：手动切换模式或切换仓库后不再带入", async () => {
    const other = {
      id: "d",
      kind: "cvs" as const,
      root: "/fixture/OtherWeb",
      name: "OtherWeb",
    };
    act(() =>
      useRepositoryStore.setState({
        logRepositories: [repositories[0], logRepository, other],
      }),
    );
    const view = render(<PanelApp />);
    await waitFor(() => expect(view.getByText("1.7 → 1.8")).toBeTruthy());
    fireEvent.contextMenu(view.getByTitle("src/SearchForm.java"));
    fireEvent.click(view.getByText("Show history of this file"));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("getCvsHistory", {
        repositoryId: "c",
        filePath: "src/SearchForm.java",
      }),
    );
    // 手动回到整个仓库再回来：回到当前文件的默认选择。
    fireEvent.click(view.getByRole("button", { name: "Whole repository" }));
    await waitFor(() => expect(view.getByText("fix the report")).toBeTruthy());
    mocks.request.mockClear();
    fireEvent.click(view.getByRole("button", { name: "Current file" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("getCvsHistory", {
        repositoryId: "c",
        filePath: "src/Search.java",
      }),
    );
    expect(
      mocks.request.mock.calls.some(
        ([, params]) =>
          (params as { filePath?: string })?.filePath === "src/SearchForm.java",
      ),
    ).toBe(false);
    // 切换到另一个 CVS 仓库：旧文件不带过去。
    fireEvent.click(view.getByRole("button", { name: "Whole repository" }));
    await waitFor(() => expect(view.getByText("fix the report")).toBeTruthy());
    fireEvent.contextMenu(view.getByTitle("src/SearchForm.java"));
    fireEvent.click(view.getByText("Show history of this file"));
    await waitFor(() => expect(view.getByText("Current file")).toBeTruthy());
    mocks.request.mockClear();
    act(() => useRepositoryStore.setState({ logRepositoryId: "d" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("getCvsHistory", {
        repositoryId: "d",
        filePath: "src/Search.java",
      }),
    );
    expect(
      mocks.request.mock.calls.some(
        ([, params]) =>
          (params as { filePath?: string })?.filePath === "src/SearchForm.java",
      ),
    ).toBe(false);
  });

  it("先显示缓存并标明时间，再显示增量结果；增量失败时保留列表并报告原因", async () => {
    let finish: (value: unknown) => void = () => {};
    const cachedAt = new Date(2026, 10, 10, 9, 5).getTime();
    mocks.request.mockImplementation(
      async (command: string, params: Record<string, unknown> = {}) => {
        if (command === "getRepositories") return workspace();
        if (command === "getCvsCommit")
          return commitFiles[params.commitId as string];
        if (command === "getCvsLog" && params.cached)
          return { commits: logCommits, days: 90, cachedAt, fromCache: true };
        if (command === "getCvsLog")
          return new Promise((resolve) => {
            finish = resolve;
          });
        return [];
      },
    );
    const view = render(<PanelApp />);
    await waitFor(() => expect(view.getByText("fix the report")).toBeTruthy());
    expect(view.getByText("Cached at 09:05")).toBeTruthy();
    act(() =>
      finish({ commits: logCommits, days: 90, cachedAt, fromCache: false }),
    );
    await waitFor(() => expect(view.queryByText("Cached at 09:05")).toBeNull());
    // 刷新直接取增量，不再先读缓存；增量失败时保留已显示的列表。
    mocks.request.mockClear();
    fireEvent.click(view.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("getCvsLog", {
        repositoryId: "c",
        days: 90,
        refresh: true,
      }),
    );
    expect(
      mocks.request.mock.calls.some(
        ([, params]) => (params as { cached?: boolean })?.cached,
      ),
    ).toBe(false);
    act(() =>
      finish({
        commits: logCommits,
        days: 90,
        cachedAt,
        fromCache: true,
        error: "CVS failed.",
      }),
    );
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain("CVS failed."),
    );
    expect(view.getByText("fix the report")).toBeTruthy();
    expect(view.getByText("Cached at 09:05")).toBeTruthy();
  });

  it("本地没有的文件带标记；右键菜单：打开文件、与工作副本比较在本地没有时置灰并提示先更新", async () => {
    commitFiles.k2 = [
      {
        path: "src/Here.java",
        revision: "1.8",
        previous: "1.7",
        kind: "modified",
        local: true,
      },
      { path: "lib/New.java", revision: "1.1", kind: "added", local: false },
    ];
    const view = render(<PanelApp />);
    await waitFor(() => expect(view.getByTitle("lib/New.java")).toBeTruthy());
    expect(view.getAllByText("Not local")).toHaveLength(1);
    expect(view.getByTitle("src/Here.java").textContent).not.toContain(
      "Not local",
    );
    const menuItem = (name: string) =>
      view.getByRole("menuitem", { name }) as HTMLButtonElement;
    // 本地有：三项都可用，请求带仓库、路径、修订。
    fireEvent.contextMenu(view.getByTitle("src/Here.java"));
    expect(
      [
        "Open File",
        "Compare with Working Copy",
        "Show history of this file",
      ].map((name) => menuItem(name).disabled),
    ).toEqual([false, false, false]);
    expect(
      view.getAllByRole("menuitem").map((item) => item.textContent),
    ).toEqual([
      "Open File",
      "Compare with Working Copy",
      "Show history of this file",
    ]);
    mocks.request.mockClear();
    fireEvent.click(menuItem("Open File"));
    expect(mocks.request).toHaveBeenCalledWith("openFile", {
      repositoryId: "c",
      filePath: "src/Here.java",
    });
    fireEvent.contextMenu(view.getByTitle("src/Here.java"));
    fireEvent.click(menuItem("Compare with Working Copy"));
    expect(mocks.request).toHaveBeenCalledWith("compareCvsWorkingFile", {
      repositoryId: "c",
      filePath: "src/Here.java",
      revision: "1.8",
    });
    // 本地没有：前两项置灰并提示，不发请求；显示历史仍可用。
    fireEvent.contextMenu(view.getByTitle("lib/New.java"));
    expect(menuItem("Open File").disabled).toBe(true);
    expect(menuItem("Compare with Working Copy").disabled).toBe(true);
    expect(menuItem("Open File").title).toBe(
      "Not in the working copy. Update the project first.",
    );
    expect(menuItem("Show history of this file").disabled).toBe(false);
    mocks.request.mockClear();
    fireEvent.click(menuItem("Open File"));
    expect(mocks.request).not.toHaveBeenCalled();
  });

  it("当前文件模式的刷新按钮强制向服务器重取该文件的历史", async () => {
    const view = render(<PanelApp />);
    await waitFor(() => expect(view.getByText("fix the report")).toBeTruthy());
    fireEvent.click(view.getByRole("button", { name: "Current file" }));
    await waitFor(() =>
      expect(view.getByText("history of src/Search.java")).toBeTruthy(),
    );
    mocks.request.mockClear();
    fireEvent.click(view.getByRole("button", { name: "Refresh File History" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("getCvsHistory", {
        repositoryId: "c",
        filePath: "src/Search.java",
        refresh: true,
      }),
    );
  });

  it("失败时在面板内显示原因，范围不变", async () => {
    mocks.request.mockImplementation(async (command: string) => {
      if (command === "getRepositories") return workspace();
      if (command === "getCvsLog") throw new Error("CVS failed.");
      return [];
    });
    const view = render(<PanelApp />);
    await waitFor(() =>
      expect(view.getByRole("alert").textContent).toContain("CVS failed."),
    );
  });
});

it("日志选中未同步 CVS 时，提交面回落到第一个可用仓库", () => {
  const base = { repositories: [repositories[0]], snapshots: [] };
  expect(commitTarget({ ...base, logRepositoryId: "c" })).toBe("a");
  expect(commitTarget({ ...base, logRepositoryId: "a" })).toBe("a");
  expect(
    commitTarget({ ...base, logRepositoryId: "c", commitRepositoryId: "x" }),
  ).toBe("x");
  expect(
    commitTarget({ repositories: [], snapshots: [], logRepositoryId: "c" }),
  ).toBeUndefined();
});

it("CVS 显式选文件与打开历史查询所选文件", async () => {
  mocks.request.mockImplementation(async (command) =>
    command === "getCvsFiles" ? ["app.txt", "other.txt"] : [],
  );
  const view = render(<CvsHistory repositoryId="b" activeFile="other.txt" />);
  await waitFor(() =>
    expect((view.getByRole("combobox") as HTMLSelectElement).value).toBe(
      "other.txt",
    ),
  );
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

it("日志文件树只渲染视口，滚动可到末项且保留点击、折叠与平铺", async () => {
  const files = Array.from({ length: 1000 }, (_, index) => ({
    oldPath: `src/f-${String(index).padStart(4, "0")}.txt`,
    newPath: `src/f-${String(index).padStart(4, "0")}.txt`,
    status: "modified" as const,
    additions: 0,
    deletions: 0,
  }));
  const clicked = vi.fn(),
    context = vi.fn(),
    toggle = vi.fn();
  const props = {
    files,
    viewMode: "tree" as const,
    selectedFiles: [],
    onFileClick: clicked,
    onFileContextMenu: context,
    onToggle: toggle,
    virtualized: true,
  };
  const view = render(<FileTree {...props} />);
  expect(
    view.container.querySelectorAll(".selectable-row").length,
  ).toBeLessThan(100);
  const folder = view.getByText("src");
  fireEvent.click(folder);
  expect(toggle).toHaveBeenCalledWith("src");
  const first = view.getByText("f-0000.txt");
  fireEvent.click(first);
  expect(clicked.mock.calls[0][1]).toEqual(files[0]);
  fireEvent.contextMenu(first);
  expect(context.mock.calls[0][1]).toEqual(files[0]);
  const scroller =
    view.container.querySelector<HTMLElement>(".virtual-file-tree");
  if (!scroller) throw new Error("虚拟文件树未挂载");
  fireEvent.scroll(scroller, { target: { scrollTop: 22000 } });
  await waitFor(() => expect(view.getByText("f-0999.txt")).toBeTruthy());
  expect(
    view.container.querySelectorAll(".selectable-row").length,
  ).toBeLessThan(100);
  view.rerender(<FileTree {...props} collapsed={{ src: true }} />);
  expect(view.queryByText("f-0000.txt")).toBeNull();
  view.rerender(<FileTree {...props} viewMode="flat" />);
  expect(
    view.container.querySelectorAll(".selectable-row").length,
  ).toBeLessThan(100);
});

it("宿主内嵌摘要在消息往返前已有仓库与加载状态", async () => {
  const root = document.createElement("div");
  root.id = "root";
  root.dataset.mode = "commit";
  root.dataset.workspace = JSON.stringify({
    repositories: [repositories[0]],
    snapshots: [{ repositoryId: "a", files: [], refreshing: true }],
    logRepositoryId: "a",
  });
  document.body.append(root);
  try {
    vi.resetModules();
    const { useRepositoryStore: initialStore } = await import(
      "../shared/store/repository-store"
    );
    const state = initialStore.getState();
    expect(state.repositories.map((repo) => repo.id)).toEqual(["a"]);
    expect(state.snapshots[0].refreshing).toBe(true);
    expect(state.snapshots[0].files).toEqual([]);
    expect(state.ready).toBe(true);
    expect(mocks.request).not.toHaveBeenCalled();
  } finally {
    root.remove();
  }
});

describe("冲突", () => {
  const conflicted = (repositoryId: string) => ({
    repositoryId,
    path: "conf.txt",
    status: "conflicted" as const,
    staged: repositoryId === "a",
  });
  it("冲突文件单列合并冲突分组，宿主通知点开后展开并定位该仓", async () => {
    initializeI18n("zh-cn");
    try {
      useRepositoryStore.setState({
        repositories,
        snapshots: [
          { repositoryId: "a", files: [files[0]] },
          { repositoryId: "b", files: [files[1], conflicted("b")] },
        ],
      });
      useCommitStore.setState({
        expandedGroups: new Set(["changes"]),
        collapsedDirs: new Set(["repository:conflicts:b"]),
      });
      const view = render(<ChangeTree onSelect={() => {}} />);
      const [category] = view.getAllByRole("button", { name: "合并冲突" });
      expect(
        category.closest(".changes-row")?.querySelector(".changes-count")
          ?.textContent,
      ).toBe("1 个文件");
      expect(view.queryByText("conf.txt")).toBeNull();
      act(() => {
        for (const fn of mocks.events)
          fn("revealConflicts", { repositoryId: "b" });
      });
      expect(await view.findByText("conf.txt")).toBeTruthy();
      expect(useCommitStore.getState().expandedGroups.has("conflicts")).toBe(
        true,
      );
      // 冲突不计入更改，也不能被勾选提交。
      const [changes] = view.getAllByRole("button", { name: "更改" });
      expect(
        changes.closest(".changes-row")?.querySelector(".changes-count")
          ?.textContent,
      ).toBe("2 个文件");
    } finally {
      initializeI18n("en");
    }
  });
  it("Git 冲突文件右键“标记已解决”即暂存该文件", async () => {
    initializeI18n("zh-cn");
    try {
      useRepositoryStore.setState({
        repositories,
        snapshots: [{ repositoryId: "a", files: [conflicted("a")] }],
      });
      useCommitStore.setState({
        expandedGroups: new Set(["changes", "conflicts"]),
      });
      const view = render(<ChangeTree onSelect={() => {}} />);
      fireEvent.contextMenu(await view.findByText("conf.txt"));
      expect(view.queryByRole("menuitem", { name: "取消暂存" })).toBeNull();
      fireEvent.click(view.getByRole("menuitem", { name: "标记已解决" }));
      await waitFor(() =>
        expect(mocks.request).toHaveBeenCalledWith("stageFile", {
          repositoryId: "a",
          filePath: "conf.txt",
        }),
      );
    } finally {
      initializeI18n("en");
    }
  });
});
describe("日志历史差异", () => {
  const commit = "c".repeat(40);
  // GWH 浅克隆的根提交一次列出 5 万多个文件；0.6.13 把它们整表回传，宿主按 10000 条上限拒绝且错误被吞。
  const commitFiles = Array.from({ length: 12001 }, (_, index) => ({
    oldPath: "",
    newPath: `module/C${index}.java`,
    status: "added" as const,
    isBinary: false,
  }));
  it("打开差异不回传提交的文件列表", async () => {
    usePanelStore.setState({ selectedCommitHashes: [commit], commitFiles });
    await usePanelStore.getState().openDiffEditor(commit, commitFiles[5]);
    expect(mocks.request).toHaveBeenCalledWith("openDiffEditor", {
      commit,
      filePath: "module/C5.java",
      file: commitFiles[5],
    });
  });
  it("失败时把原文写进日志并弹出通知", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      mocks.request.mockImplementation(async (command: string) => {
        if (command === "openDiffEditor")
          throw new Error("请求字段无效：fileList");
        return undefined;
      });
      usePanelStore.setState({ selectedCommitHashes: [commit], commitFiles });
      await usePanelStore.getState().openDiffEditor(commit, commitFiles[0]);
      expect(logged).toHaveBeenCalledWith(
        "openDiffEditor failed: 请求字段无效：fileList",
      );
      expect(mocks.request).toHaveBeenCalledWith("showErrorNotification", {
        message: "请求字段无效：fileList",
      });
    } finally {
      logged.mockRestore();
    }
  });
});
describe("合并进行中", () => {
  const mergeMsg = "Merge remote-tracking branch 'origin/main'";
  // 宿主快照标记合并进行中（MERGE_HEAD）；横幅另取合并说明。
  const merging = (files: (typeof snapshots)[number]["files"]) =>
    useRepositoryStore.setState({
      snapshots: [
        { repositoryId: "a", files, merging: true },
        ...snapshots.filter((item) => item.repositoryId !== "a"),
      ],
    });
  beforeEach(() => {
    initializeI18n("zh-cn");
    const base = mocks.request.getMockImplementation();
    mocks.request.mockImplementation(
      async (command: string, params?: Record<string, unknown>) =>
        command === "getMergeState"
          ? { isMerging: true, mergeHead: "f".repeat(40), mergeMsg }
          : base?.(command, params),
    );
  });
  afterEach(() => initializeI18n("en"));
  it("横幅的继续与中止按钮有中文悬停提示和无障碍名称", async () => {
    const view = render(<CommitApp />);
    const proceed = await view.findByRole("button", {
      name: "继续合并（仍有冲突时打开冲突列表）",
    });
    expect(proceed.getAttribute("title")).toBe(
      "继续合并（仍有冲突时打开冲突列表）",
    );
    const abort = view.getByRole("button", {
      name: "中止合并 (git merge --abort)",
    });
    expect(abort.getAttribute("title")).toBe("中止合并 (git merge --abort)");
  });
  it("说明留空也能提交，交给 Git 使用默认合并说明", async () => {
    merging(snapshots[0].files);
    useCommitStore.setState({
      commitMode: true,
      selectedFiles: new Set([JSON.stringify(["a", "app.txt"])]),
    });
    const view = render(<CommitApp />);
    const message = view.getByRole("textbox", { name: "提交说明" });
    expect(message.getAttribute("placeholder")).toBe(
      "留空则使用 Git 生成的默认合并说明",
    );
    fireEvent.click(view.getByRole("button", { name: "提交" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("commitRepositories", {
        message: "",
        files: [{ repositoryId: "a", path: "app.txt" }],
        amend: false,
      }),
    );
  });
  it("解决结果与本地相同时，提交区显示合并进行中并可直接提交", async () => {
    merging([]);
    useCommitStore.setState({
      changes: files.filter((file) => file.repositoryId !== "a"),
    });
    const view = render(<CommitApp />);
    expect(await view.findByText("合并进行中，提交即完成合并")).toBeTruthy();
    fireEvent.click(view.getByRole("button", { name: "提交…" }));
    await waitFor(() =>
      expect(useCommitStore.getState().commitMode).toBe(true),
    );
    useCommitStore.setState({ selectedFiles: new Set() });
    const commit = await view.findByRole("button", { name: "提交" });
    expect((commit as HTMLButtonElement).disabled).toBe(false);
    fireEvent.click(commit);
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("commitRepositories", {
        message: "",
        files: [],
        amend: false,
        repositoryId: "a",
      }),
    );
  });
  it("仍有冲突时不显示合并进行中，也不放开空选择", async () => {
    merging([
      {
        repositoryId: "a",
        path: "app.txt",
        status: "conflicted" as const,
        staged: false,
      },
    ]);
    const view = render(<CommitApp />);
    await view.findByText("合并冲突");
    expect(view.queryByText("合并进行中，提交即完成合并")).toBeNull();
    useCommitStore.setState({ commitMode: true, selectedFiles: new Set() });
    expect(
      (
        (await view.findByRole("button", {
          name: "提交",
        })) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("不在合并中时说明为空不能提交", async () => {
    mocks.request.mockImplementation(async (command: string) =>
      command === "getMergeState" ? { isMerging: false } : [],
    );
    useCommitStore.setState({
      commitMode: true,
      selectedFiles: new Set([JSON.stringify(["a", "app.txt"])]),
    });
    const view = render(<CommitApp />);
    expect(
      (view.getByRole("button", { name: "提交" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
  it("日志分支右键合并只由宿主确认一次", async () => {
    usePanelStore.setState({
      branches: [
        {
          name: "main",
          isRemote: false,
          isCurrent: true,
          upstream: "origin/main",
          ahead: 1,
          behind: 1,
          lastCommitHash: "a".repeat(40),
        },
        {
          name: "origin/main",
          isRemote: true,
          isCurrent: false,
          ahead: 0,
          behind: 0,
          lastCommitHash: "b".repeat(40),
        },
      ],
      tags: [],
      currentBranch: "main",
    });
    const view = render(<BranchTree />);
    fireEvent.contextMenu(view.getByText("origin/main"));
    fireEvent.click(await view.findByText("将 'origin/main' 合并到 'main'"));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("mergeBranch", {
        branchName: "origin/main",
      }),
    );
    expect(mocks.request).not.toHaveBeenCalledWith(
      "showConfirmMessage",
      expect.anything(),
    );
  });
});
describe("破坏性操作只确认一次", () => {
  const branches = [
    {
      name: "main",
      isRemote: false,
      isCurrent: true,
      upstream: "origin/main",
      ahead: 1,
      behind: 1,
      lastCommitHash: "a".repeat(40),
    },
    {
      name: "feature",
      isRemote: false,
      isCurrent: false,
      ahead: 0,
      behind: 0,
      lastCommitHash: "b".repeat(40),
    },
  ];
  beforeEach(() =>
    usePanelStore.setState({ branches, tags: [], currentBranch: "main" }),
  );
  const noWebviewConfirm = () =>
    expect(mocks.request).not.toHaveBeenCalledWith(
      "showConfirmMessage",
      expect.anything(),
    );
  it("分支变基与删除直接交给宿主确认", async () => {
    const view = render(<BranchTree />);
    fireEvent.contextMenu(view.getByText("feature"));
    fireEvent.click(await view.findByText("Rebase 'main' onto 'feature'"));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("rebaseBranch", {
        onto: "feature",
      }),
    );
    fireEvent.contextMenu(view.getByText("feature"));
    fireEvent.click(await view.findByText("Delete"));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("deleteBranch", {
        branchName: "feature",
        isRemote: false,
        force: false,
      }),
    );
    noWebviewConfirm();
  });
  it("未完全合并时改为强制删除，由宿主写明后果再确认", async () => {
    mocks.request.mockImplementation(
      async (command: string, params?: Record<string, unknown>) => {
        if (command === "deleteBranch" && params?.force === false)
          throw new Error("error: The branch 'feature' is not fully merged.");
        return undefined;
      },
    );
    const view = render(<BranchTree />);
    fireEvent.contextMenu(view.getByText("feature"));
    fireEvent.click(await view.findByText("Delete"));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("deleteBranch", {
        branchName: "feature",
        isRemote: false,
        force: true,
      }),
    );
    noWebviewConfirm();
  });
  it("硬重置与丢弃提交直接交给宿主确认", async () => {
    const commit = {
      hash: "c".repeat(40),
      shortHash: "ccccccc",
      parents: ["d".repeat(40)],
      authorName: "dev",
      authorEmail: "dev@example.invalid",
      authorDate: "2026-11-05T00:00:00Z",
      subject: "change",
      body: "",
      refs: [],
    };
    for (const [label, command] of [
      ["Reset Current Branch to Here (Hard)...", "resetToCommit"],
      ["Drop Commit", "dropCommit"],
    ]) {
      const view = render(
        <CommitContextMenu
          x={0}
          y={0}
          commit={commit}
          onClose={() => {}}
          onCreateBranch={() => {}}
        />,
      );
      fireEvent.click(await view.findByText(label));
      await waitFor(() =>
        expect(mocks.request).toHaveBeenCalledWith(
          command,
          expect.objectContaining({ hash: commit.hash }),
        ),
      );
      cleanup();
    }
    noWebviewConfirm();
  });
});
describe("合并失败原因", () => {
  it("合并失败把宿主给的原因写进日志并通知，不再是 {}", async () => {
    const logged = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const reason = "Merge failed: 1 file(s) have conflicts, first: app.txt";
      mocks.request.mockImplementation(async (command: string) => {
        if (command === "mergeBranch") throw new Error(reason);
        return undefined;
      });
      usePanelStore.setState({
        branches: [
          {
            name: "main",
            isRemote: false,
            isCurrent: true,
            ahead: 0,
            behind: 0,
            lastCommitHash: "a".repeat(40),
          },
          {
            name: "feature",
            isRemote: false,
            isCurrent: false,
            ahead: 0,
            behind: 0,
            lastCommitHash: "b".repeat(40),
          },
        ],
        tags: [],
        currentBranch: "main",
      });
      const view = render(<BranchTree />);
      fireEvent.contextMenu(view.getByText("feature"));
      fireEvent.click(await view.findByText("Merge 'feature' into 'main'"));
      await waitFor(() =>
        expect(logged).toHaveBeenCalledWith(`Merge failed: ${reason}`),
      );
      expect(mocks.request).toHaveBeenCalledWith("showErrorNotification", {
        message: reason,
      });
    } finally {
      logged.mockRestore();
    }
  });
});
describe("大批量回滚", () => {
  it("Ctrl+A 选中全部更改，回滚一次带上全部文件", async () => {
    const many = Array.from({ length: 12000 }, (_, index) => ({
      repositoryId: "a",
      path: `bulk/F${index}.txt`,
      status: "modified" as const,
      staged: false,
    }));
    useRepositoryStore.setState({
      snapshots: [
        { repositoryId: "a", files: many },
        ...snapshots.filter((item) => item.repositoryId !== "a"),
      ],
    });
    useCommitStore.setState({ changes: many });
    const view = render(<CommitApp />);
    const tree = await view.findByLabelText("Changed Files");
    fireEvent.keyDown(tree, { key: "a", ctrlKey: true });
    // 全部更改（含另一仓的 1 个），不含未受版本控制的文件。
    expect(useCommitStore.getState().highlightedFiles.size).toBe(12001);
    fireEvent.click(view.getByRole("button", { name: "Rollback" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        "openRollbackPanel",
        expect.objectContaining({
          files: expect.arrayContaining([
            { path: "bulk/F11999.txt", status: "modified", staged: false },
          ]),
        }),
      ),
    );
    const call = mocks.request.mock.calls.find(
      ([command]) => command === "openRollbackPanel",
    );
    expect((call?.[1] as { files: unknown[] }).files).toHaveLength(12000);
  });
});

describe("修改上次提交后推送", () => {
  const commit = {
    hash: "c".repeat(40),
    shortHash: "ccccccc",
    parents: ["d".repeat(40)],
    authorName: "dev",
    authorEmail: "dev@example.invalid",
    authorDate: "2026-11-05T10:00:00+08:00",
    subject: "amended",
    body: "",
    refs: [],
  };
  const mount = (amended?: string) => {
    const root = document.createElement("div");
    root.id = "root";
    root.dataset.branch = "main";
    root.dataset.remote = "origin";
    document.body.append(root);
    mocks.request.mockImplementation(async (command: string) => {
      if (command === "getAheadCommits") return { commits: [commit], amended };
      if (command === "executePush") return { success: false, cancelled: true };
      return [];
    });
    const view = render(<PushApp />, { container: root });
    return { view, root };
  };
  afterEach(() => document.getElementById("root")?.remove());
  it("远端是修改前的提交时主按钮为强制推送，交给宿主确认一次；取消后不报已推送", async () => {
    const { view } = mount("e".repeat(40));
    fireEvent.click(await view.findByRole("button", { name: "Force Push" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith("executePush", {
        branchName: "main",
        remote: "origin",
        targetBranch: "main",
        force: true,
      }),
    );
    await waitFor(() =>
      expect(
        (view.getByRole("button", { name: "Force Push" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
    expect(mocks.request).not.toHaveBeenCalledWith(
      "showInfoNotification",
      expect.anything(),
    );
    expect(mocks.request).not.toHaveBeenCalledWith("closePushPanel", undefined);
  });
  it("没有修改已推送的提交时仍是普通推送", async () => {
    const { view } = mount();
    await view.findAllByText("amended");
    fireEvent.click(view.getByRole("button", { name: "Push" }));
    await waitFor(() =>
      expect(mocks.request).toHaveBeenCalledWith(
        "executePush",
        expect.objectContaining({ force: false }),
      ),
    );
  });
});
