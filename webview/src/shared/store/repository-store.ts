import { create } from "zustand";
import { bridge } from "../bridge";
import { setBridgeRepository } from "../bridge/vscode-bridge";
import {
  applySnapshotDelta,
  type RepositoryInfo,
  type RepositorySnapshot,
  type SnapshotDelta,
} from "../models/changes";
export interface WorkspaceState {
  repositories: RepositoryInfo[];
  snapshots: RepositorySnapshot[];
  unsyncedCvsCount?: number;
  logRepositoryId?: string;
  commitRepositoryId?: string;
  activeFile?: string;
  historyRequest?: { repositoryId: string; sequence: number };
}
interface RepositoryStore extends WorkspaceState {
  ready: boolean;
  load: () => Promise<void>;
  apply: (state: WorkspaceState) => void;
  select: (id: string, surface: "commit" | "log") => Promise<void>;
}
function bind(state: WorkspaceState) {
  const mode = document.getElementById("root")?.dataset.mode;
  const id =
    mode === "commit"
      ? (state.commitRepositoryId ?? state.logRepositoryId)
      : state.logRepositoryId;
  const repository = state.repositories.find((item) => item.id === id);
  setBridgeRepository(id, repository?.kind);
}
// 首次绘制直接使用宿主 HTML 中的无文件摘要，完整状态仍走原消息通道。
const initialWorkspace = (() => {
  const value = document.getElementById("root")?.dataset.workspace;
  if (!value) return undefined;
  try {
    return JSON.parse(value) as WorkspaceState;
  } catch {
    return undefined;
  }
})();
if (initialWorkspace) bind(initialWorkspace);
export const useRepositoryStore = create<RepositoryStore>((set, get) => ({
  repositories: [],
  snapshots: [],
  unsyncedCvsCount: 0,
  ...initialWorkspace,
  ready: !!initialWorkspace,
  apply(state) {
    bind(state);
    set({
      ...state,
      logRepositoryId: state.logRepositoryId,
      commitRepositoryId: state.commitRepositoryId,
      activeFile: state.activeFile,
      historyRequest: state.historyRequest,
      ready: true,
    });
  },
  async load() {
    get().apply((await bridge.request("getRepositories")) as WorkspaceState);
  },
  async select(id, surface) {
    const metadata = (await bridge.request("selectRepository", {
      repositoryId: id,
      surface,
    })) as Omit<WorkspaceState, "snapshots">;
    get().apply({ ...get(), ...metadata });
  },
}));
bridge.onEvent((event, data) => {
  if (event === "repositoriesChanged")
    useRepositoryStore.getState().apply(data as WorkspaceState);
  if (event === "repositoryList") {
    const metadata = data as Omit<WorkspaceState, "snapshots">;
    const current = useRepositoryStore.getState();
    current.apply({
      ...metadata,
      snapshots: current.snapshots.filter((snapshot) =>
        metadata.repositories.some((repo) => repo.id === snapshot.repositoryId),
      ),
    });
  }
  if (event === "repositorySnapshotDelta") {
    const delta = data as SnapshotDelta;
    useRepositoryStore.setState((state) => ({
      snapshots: state.snapshots.map((snapshot) =>
        snapshot.repositoryId === delta.repositoryId
          ? applySnapshotDelta(snapshot, delta)
          : snapshot,
      ),
    }));
  }
  if (event === "repositorySnapshot") {
    const snapshot = data as RepositorySnapshot;
    useRepositoryStore.setState((state) => ({
      snapshots: [
        ...state.snapshots.filter(
          (item) => item.repositoryId !== snapshot.repositoryId,
        ),
        snapshot,
      ],
    }));
  }
});
