import { create } from "zustand";
import { bridge } from "../bridge";
import { t } from "../i18n";

import {
  type ChangeFile,
  canCommit,
  fileKey,
  groupChanges,
  initialSelection,
} from "../models/changes";
import { useRepositoryStore, type WorkspaceState } from "./repository-store";
export type WorkingTreeFile = ChangeFile;

export interface ShelveEntry {
  id: string;
  message: string;
  date: string;
  branch: string;
  files: string[];
}

export interface IdeaShelfEntry {
  name: string;
  description: string;
  date: string;
  patchPath: string;
  files: string[];
}

type TabType = "commit" | "shelf" | "stash";

interface CommitStore {
  // File changes
  changes: WorkingTreeFile[];
  selectedFiles: Set<string>;
  /** Files highlighted via click/Cmd+click (for context menu operations) */
  highlightedFiles: Set<string>;

  // Commit state
  commitMessage: string;
  amend: boolean;

  // Shelf
  shelves: ShelveEntry[];

  // IDEA Shelf
  ideaShelves: IdeaShelfEntry[];

  // UI state
  activeTab: TabType;
  loading: boolean;
  error?: string;
  expandedGroups: Set<string>;
  groupByDirectory: boolean;
  showUnversioned: boolean;
  /** Collapsed directory paths in tree view */
  collapsedDirs: Set<string>;

  // Actions
  fetchChanges: () => Promise<void>;
  fetchShelves: () => Promise<void>;
  setCommitMessage: (msg: string) => void;
  setAmend: (amend: boolean) => void;
  toggleFileSelection: (filePath: string) => void;
  setFileKeys: (keys: string[], selected: boolean) => void;
  selectAllFiles: () => void;
  deselectAllFiles: () => void;
  highlightFile: (key: string, mode: "single" | "toggle") => void;
  stageFile: (filePath: string) => Promise<void>;
  unstageFile: (filePath: string) => Promise<void>;
  stageAll: () => Promise<void>;
  unstageAll: () => Promise<void>;
  commit: () => Promise<boolean>;
  commitAndPush: () => Promise<boolean>;
  rollbackFile: (filePath: string) => Promise<void>;
  showDiff: (filePath: string, staged?: boolean) => Promise<void>;
  shelveChanges: (message?: string, filePaths?: string[]) => Promise<void>;
  unshelveChanges: (stashId: string, drop?: boolean) => Promise<void>;
  deleteShelve: (stashId: string) => Promise<void>;
  fetchIdeaShelves: () => Promise<void>;
  ideaShelveChanges: (message?: string, filePaths?: string[]) => Promise<void>;
  ideaUnshelveChanges: (shelfName: string, drop?: boolean) => Promise<void>;
  deleteIdeaShelf: (shelfName: string) => Promise<void>;
  setActiveTab: (tab: TabType) => void;
  toggleGroup: (group: string) => void;
  toggleDir: (dirPath: string) => void;
  expandAllDirs: () => void;
  collapseAllDirs: (allDirPaths: string[]) => void;
  toggleGroupByDirectory: () => void;
  toggleShowUnversioned: () => void;
  refresh: () => Promise<void>;
}

export const useCommitStore = create<CommitStore>((set, get) => ({
  changes: [],
  selectedFiles: initialSelection([]),
  highlightedFiles: new Set<string>(),
  commitMessage: "",
  amend: false,
  shelves: [],
  ideaShelves: [],
  activeTab: "commit",
  loading: false,
  expandedGroups: new Set(["changes", "staged"]),
  groupByDirectory: true,
  showUnversioned: true,
  collapsedDirs: new Set<string>(),

  async fetchChanges() {
    try {
      const result = (await bridge.request(
        "getRepositoryChanges",
      )) as WorkspaceState;
      useRepositoryStore.getState().apply(result);
      const groups = groupChanges(result.repositories, result.snapshots);
      const changes = groups.flatMap((group) => [
        ...group.changes,
        ...group.unversioned,
        ...group.incoming,
      ]);
      const valid = new Set(changes.filter(canCommit).map(fileKey));
      set({
        changes,
        selectedFiles: new Set(
          [...get().selectedFiles].filter((key) => valid.has(key)),
        ),
      });
    } catch (error) {
      set({
        error:
          error instanceof Error
            ? error.message
            : t("Unable to refresh changes."),
      });
    }
  },

  async fetchShelves() {
    try {
      const result = (await bridge.request("getShelves")) as ShelveEntry[];
      if (Array.isArray(result)) {
        set({ shelves: result });
      }
    } catch (err) {
      console.error("fetchShelves failed:", err);
    }
  },

  setCommitMessage(msg: string) {
    set({ commitMessage: msg });
  },

  setAmend(amend: boolean) {
    set({ amend });
    if (amend) {
      // Load last commit message
      void (async () => {
        try {
          const result = (await bridge.request("getAmendMessage", {
            repositoryId: get().changes.find((file) =>
              get().selectedFiles.has(fileKey(file)),
            )?.repositoryId,
          })) as {
            message: string;
          };
          if (result?.message) {
            set({ commitMessage: result.message });
          }
        } catch {
          // ignore
        }
      })();
    }
  },

  toggleFileSelection(key: string) {
    const { selectedFiles } = get();
    const next = new Set(selectedFiles);
    if (next.has(key)) {
      next.delete(key);
    } else {
      next.add(key);
    }
    set({ selectedFiles: next });
  },

  setFileKeys(keys: string[], selected: boolean) {
    const { selectedFiles } = get();
    const next = new Set(selectedFiles);
    for (const key of keys) {
      if (selected) {
        next.add(key);
      } else {
        next.delete(key);
      }
    }
    set({ selectedFiles: next });
  },

  selectAllFiles() {
    const { changes } = get();
    const allPaths = new Set(changes.filter(canCommit).map(fileKey));
    set({ selectedFiles: allPaths });
  },

  deselectAllFiles() {
    set({ selectedFiles: new Set() });
  },

  highlightFile(key: string, mode: "single" | "toggle") {
    const { highlightedFiles } = get();
    if (mode === "single") {
      set({ highlightedFiles: new Set([key]) });
    } else {
      // toggle (Cmd+click)
      const next = new Set(highlightedFiles);
      if (next.has(key)) {
        next.delete(key);
      } else {
        next.add(key);
      }
      set({ highlightedFiles: next });
    }
  },

  async stageFile(filePath: string) {
    try {
      await bridge.request("stageFile", { filePath });
      await get().fetchChanges();
    } catch (err) {
      console.error("stageFile failed:", err);
    }
  },

  async unstageFile(filePath: string) {
    try {
      await bridge.request("unstageFile", { filePath });
      await get().fetchChanges();
    } catch (err) {
      console.error("unstageFile failed:", err);
    }
  },

  async stageAll() {
    try {
      await bridge.request("stageAll");
      await get().fetchChanges();
    } catch (err) {
      console.error("stageAll failed:", err);
    }
  },

  async unstageAll() {
    try {
      await bridge.request("unstageAll");
      await get().fetchChanges();
    } catch (err) {
      console.error("unstageAll failed:", err);
    }
  },

  async commit() {
    const { commitMessage, changes, selectedFiles, amend } = get();
    const files = changes
      .filter((file) => canCommit(file) && selectedFiles.has(fileKey(file)))
      .map((file) => ({ repositoryId: file.repositoryId, path: file.path }));
    if (!commitMessage.trim() || !files.length) return false;
    try {
      set({ loading: true, error: undefined });
      await bridge.request("commitRepositories", {
        message: commitMessage,
        files,
        amend,
      });
      set({ commitMessage: "", amend: false, selectedFiles: new Set() });
      await get().fetchChanges();
      return true;
    } catch (error) {
      set({
        error: error instanceof Error ? error.message : t("Commit failed."),
      });
      return false;
    } finally {
      set({ loading: false });
    }
  },
  async commitAndPush() {
    const selected = get().changes.filter((file) =>
      get().selectedFiles.has(fileKey(file)),
    );
    const roots = new Set(selected.map((file) => file.repositoryId));
    const repositoryId = selected[0]?.repositoryId;
    if (
      roots.size !== 1 ||
      useRepositoryStore
        .getState()
        .repositories.find((item) => item.id === repositoryId)?.kind !== "git"
    ) {
      set({
        error: t(
          "Commit and Push is available for one Git repository at a time.",
        ),
      });
      return false;
    }
    if (!(await get().commit())) return false;
    await bridge.request("openPushPanel", { repositoryId });
    return true;
  },

  async rollbackFile(filePath: string) {
    try {
      await bridge.request("rollbackFile", { filePath });
      await get().fetchChanges();
    } catch (err) {
      console.error("rollbackFile failed:", err);
    }
  },

  async showDiff(filePath: string, staged?: boolean) {
    try {
      await bridge.request("showDiffForWorkingFile", { filePath, staged });
    } catch (err) {
      console.error("showDiff failed:", err);
    }
  },

  async shelveChanges(message?: string, filePaths?: string[]) {
    try {
      set({ loading: true });
      await bridge.request("shelveChanges", { message, filePaths });
      await get().fetchChanges();
      await get().fetchShelves();
    } catch (err) {
      console.error("shelveChanges failed:", err);
    } finally {
      set({ loading: false });
    }
  },

  async unshelveChanges(stashId: string, drop = true) {
    try {
      set({ loading: true });
      await bridge.request("unshelveChanges", { stashId, drop });
      await get().fetchChanges();
      await get().fetchShelves();
    } catch (err) {
      console.error("unshelveChanges failed:", err);
    } finally {
      set({ loading: false });
    }
  },

  async deleteShelve(stashId: string) {
    try {
      await bridge.request("deleteShelve", { stashId });
      await get().fetchShelves();
    } catch (err) {
      console.error("deleteShelve failed:", err);
    }
  },

  async fetchIdeaShelves() {
    try {
      const result = (await bridge.request(
        "getIdeaShelves",
      )) as IdeaShelfEntry[];
      if (Array.isArray(result)) {
        set({ ideaShelves: result });
      }
    } catch (err) {
      console.error("fetchIdeaShelves failed:", err);
    }
  },

  async ideaShelveChanges(message?: string, filePaths?: string[]) {
    try {
      set({ loading: true });
      await bridge.request("ideaShelveChanges", { message, filePaths });
      await get().fetchChanges();
      await get().fetchIdeaShelves();
    } catch (err) {
      console.error("ideaShelveChanges failed:", err);
    } finally {
      set({ loading: false });
    }
  },

  async ideaUnshelveChanges(shelfName: string, drop = true) {
    try {
      set({ loading: true });
      await bridge.request("ideaUnshelveChanges", { shelfName, drop });
      await get().fetchChanges();
      await get().fetchIdeaShelves();
    } catch (err) {
      console.error("ideaUnshelveChanges failed:", err);
    } finally {
      set({ loading: false });
    }
  },

  async deleteIdeaShelf(shelfName: string) {
    try {
      await bridge.request("deleteIdeaShelf", { shelfName });
      await get().fetchIdeaShelves();
    } catch (err) {
      console.error("deleteIdeaShelf failed:", err);
    }
  },

  setActiveTab(tab: TabType) {
    set({ activeTab: tab });
    if (tab === "stash") {
      get().fetchShelves();
    } else if (tab === "shelf") {
      get().fetchIdeaShelves();
    }
  },

  toggleGroup(group: string) {
    const { expandedGroups } = get();
    const next = new Set(expandedGroups);
    if (next.has(group)) {
      next.delete(group);
    } else {
      next.add(group);
    }
    set({ expandedGroups: next });
  },

  toggleDir(dirPath: string) {
    const { collapsedDirs } = get();
    const next = new Set(collapsedDirs);
    if (next.has(dirPath)) {
      next.delete(dirPath);
    } else {
      next.add(dirPath);
    }
    set({ collapsedDirs: next });
  },

  expandAllDirs() {
    set({ collapsedDirs: new Set() });
  },

  collapseAllDirs(allDirPaths: string[]) {
    set({ collapsedDirs: new Set(allDirPaths) });
  },

  toggleGroupByDirectory() {
    const next = !get().groupByDirectory;
    // When toggling to directory mode, reset collapsed state so DirectoryTree will collapse all on mount
    if (next) {
      set({ groupByDirectory: true, collapsedDirs: new Set() });
    } else {
      set({ groupByDirectory: false, collapsedDirs: new Set() });
    }
  },

  toggleShowUnversioned() {
    set({ showUnversioned: !get().showUnversioned });
  },

  async refresh() {
    await Promise.all([
      get().fetchChanges(),
      get().fetchShelves(),
      get().fetchIdeaShelves(),
    ]);
  },
}));

// 快照只影响对应仓库，保留其它仓库的选择和提交说明。
bridge.onEvent((event, data) => {
  if (["repositoriesChanged", "repositorySnapshot"].includes(event))
    void useCommitStore.getState().fetchChanges();
  if (event === "commitCommand") {
    const command = (data as { command: string }).command;
    const store = useCommitStore.getState();
    if (command === "commit") void store.commit();
    if (command === "commitAndPush") void store.commitAndPush();
    if (command === "refresh") void bridge.request("refreshRepositories");
    if (command === "shelve") store.setActiveTab("shelf");
    if (command === "unshelve") store.setActiveTab("shelf");
  }
});
