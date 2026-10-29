import { create } from "zustand";
import { bridge } from "../bridge";
import { setBridgeRepository } from "../bridge/vscode-bridge";
import type { RepositoryInfo, RepositorySnapshot } from "../models/changes";
export interface WorkspaceState {
  repositories: RepositoryInfo[];
  snapshots: RepositorySnapshot[];
  logRepositoryId?: string;
  commitRepositoryId?: string;
  activeFile?: string;
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
export const useRepositoryStore = create<RepositoryStore>((set, get) => ({
  repositories: [],
  snapshots: [],
  ready: false,
  apply(state) {
    bind(state);
    set({ ...state, ready: true });
  },
  async load() {
    get().apply((await bridge.request("getRepositories")) as WorkspaceState);
  },
  async select(id, surface) {
    get().apply(
      (await bridge.request("selectRepository", {
        repositoryId: id,
        surface,
      })) as WorkspaceState,
    );
  },
}));
bridge.onEvent((event, data) => {
  if (event === "repositoriesChanged")
    useRepositoryStore.getState().apply(data as WorkspaceState);
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
