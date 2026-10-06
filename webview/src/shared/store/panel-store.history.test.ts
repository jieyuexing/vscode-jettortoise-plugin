import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

type Deferred<T> = {
  promise: Promise<T>;
  resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

const listeners: Array<(event: string, data: unknown) => void> = [];
const graphRequests: Array<Deferred<unknown>> = [];
const persisted = vi.fn();
let restoredState: unknown;

const bridge = {
  getState: () => restoredState,
  setState: persisted,
  request: vi.fn((command: string) => {
    if (command === "getGraphData") {
      const request = deferred<unknown>();
      graphRequests.push(request);
      return request.promise;
    }
    if (command === "getCommitRangeFiles") return Promise.resolve([]);
    return Promise.resolve([]);
  }),
  onEvent: vi.fn((listener: (event: string, data: unknown) => void) => {
    listeners.push(listener);
    return () => {};
  }),
};

vi.mock("../bridge", () => ({ bridge }));

function graph(hash: string, subject = "revision") {
  return {
    graphData: {
      commits: [
        {
          hash,
          subject,
          body: "",
          authorName: "author",
          authorDate: "2026-09-15T00:00:00.000Z",
        },
      ],
      lanes: {},
    },
    snapshot: null,
  };
}

async function flush() {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
  await vi.runAllTimersAsync();
}

async function loadStore() {
  vi.resetModules();
  return import("./panel-store");
}

describe("history editor panel store", () => {
  beforeEach(() => {
    listeners.length = 0;
    graphRequests.length = 0;
    restoredState = undefined;
    bridge.request.mockClear();
    bridge.onEvent.mockClear();
    persisted.mockClear();
    vi.useFakeTimers();
    vi.stubGlobal("document", {
      getElementById: (id: string) =>
        id === "root" ? { dataset: { mode: "panel" } } : null,
    });
    vi.stubGlobal("localStorage", {
      getItem: () => null,
      setItem: vi.fn(),
    });
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("keeps the newest file-history response when an earlier request finishes last", async () => {
    const { usePanelStore } = await loadStore();
    const first = usePanelStore.getState().fetchInitialData();
    expect(graphRequests).toHaveLength(1);

    listeners[0]("showFileHistory", { file: "latest.ts" });
    expect(graphRequests).toHaveLength(2);

    graphRequests[1].resolve(graph("b".repeat(40)));
    await flush();
    expect(usePanelStore.getState().filter.file).toBe("latest.ts");
    expect(
      usePanelStore.getState().commits.map((commit) => commit.hash),
    ).toEqual(["b".repeat(40)]);

    graphRequests[0].resolve(graph("a".repeat(40)));
    await flush();
    await first;

    expect(usePanelStore.getState().filter.file).toBe("latest.ts");
    expect(
      usePanelStore.getState().commits.map((commit) => commit.hash),
    ).toEqual(["b".repeat(40)]);
    expect(bridge.request).toHaveBeenCalledWith("getGraphData", {
      maxCount: 200,
      branch: undefined,
      file: "latest.ts",
    });
  });

  it("restores a valid file filter and revision selection without persisting file content", async () => {
    const hash = "c".repeat(40);
    restoredState = {
      version: 1,
      filter: { file: "src/history.ts", searchQuery: "needle" },
      selectedCommitHashes: [hash],
      visibleColumns: { author: false },
    };

    const { usePanelStore } = await loadStore();
    const request = usePanelStore.getState().fetchInitialData();
    expect(graphRequests).toHaveLength(1);
    graphRequests[0].resolve(graph(hash, "needle revision"));
    await flush();
    await request;

    expect(usePanelStore.getState().filter).toMatchObject({
      file: "src/history.ts",
      searchQuery: "needle",
    });
    expect(usePanelStore.getState().selectedCommitHashes).toEqual([hash]);
    expect(usePanelStore.getState().selectedCommitHash).toBe(hash);
    expect(usePanelStore.getState().visibleColumns.author).toBe(false);
    expect(bridge.request).toHaveBeenCalledWith("getGraphData", {
      maxCount: 200,
      branch: undefined,
      file: "src/history.ts",
    });

    usePanelStore.setState({
      commitFiles: [
        { path: "src/history.ts", content: "private contents" } as never,
      ],
    });
    const saved = persisted.mock.calls.at(-1)?.[0] as Record<string, unknown>;
    expect(saved).toMatchObject({
      version: 2,
      history: {
        version: 1,
        filter: { file: "src/history.ts" },
        selectedCommitHashes: [hash],
      },
    });
    expect(JSON.stringify(saved)).not.toContain("private contents");
    expect(saved).not.toHaveProperty("commitFiles");
  });

  it("queues commit focus before render without clearing the current file filter", async () => {
    restoredState = { version: 1, filter: { file: "kept.ts" } };
    const { usePanelStore } = await loadStore();
    const { useWorkbenchStore } = await import("./workbench-store");
    listeners[0]("showCommitPanel", {});
    expect(useWorkbenchStore.getState().commitRevealRequest).toBe(1);
    expect(usePanelStore.getState().filter.file).toBe("kept.ts");
    expect(bridge.request).not.toHaveBeenCalled();
  });

  it("keeps selection when a Git change refreshes the existing history tab", async () => {
    const hash = "d".repeat(40);
    const { usePanelStore } = await loadStore();
    usePanelStore.setState({
      selectedCommitHash: hash,
      selectedCommitHashes: [hash],
    });
    listeners[0]("gitStateChanged", { scope: "all" });
    const result = graph("e".repeat(40));
    result.graphData.commits.push(graph(hash).graphData.commits[0]);
    graphRequests[0].resolve(result);
    await flush();
    expect(usePanelStore.getState().selectedCommitHash).toBe(hash);
  });
});
