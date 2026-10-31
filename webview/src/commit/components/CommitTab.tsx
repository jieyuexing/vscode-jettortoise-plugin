import { useEffect, useRef, useState } from "react";
import { bridge } from "../../shared/bridge";
import { t } from "../../shared/i18n";
import {
  type ChangeFile,
  canCommit,
  fileKey,
} from "../../shared/models/changes";
import { useCommitStore } from "../../shared/store/commit-store";
import { useRepositoryStore } from "../../shared/store/repository-store";
import { ChangeTree, changeAction } from "./ChangeTree";
import { CommitMessageArea } from "./CommitMessageArea";
import { DiffPreview } from "./DiffPreview";
import { IdeaShelfTab } from "./IdeaShelfTab";
import { ShelfTab } from "./ShelfTab";
import { Toolbar } from "./Toolbar";

export function CommitTab() {
  const { repositories, commitRepositoryId, logRepositoryId, select } =
    useRepositoryStore();
  const state = useCommitStore();
  const container = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);
  const [preview, setPreview] = useState(true);
  const [ratio, setRatio] = useState(0.42);
  const [previewKey, setPreviewKey] = useState<string>();
  const selectSequence = useRef(0);
  const wide = width >= 760;
  const hasGit = repositories.some((repo) => repo.kind === "git");
  const currentId = commitRepositoryId ?? logRepositoryId;
  const current = repositories.find((repo) => repo.id === currentId);
  const file = state.changes.find((file) => fileKey(file) === previewKey);
  const files = state.changes.filter(
    (file) =>
      !file.directory && !["incoming", "untracked"].includes(file.status),
  );
  useEffect(() => {
    const observer = new ResizeObserver((entries) =>
      setWidth(entries[0].contentRect.width),
    );
    if (container.current) observer.observe(container.current);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if (
        (event.ctrlKey || event.metaKey) &&
        event.key.toLowerCase() === "k" &&
        repositories.length
      ) {
        event.preventDefault();
        state.enterCommitMode();
      }
      if (event.key === "Escape") state.leaveCommitMode();
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [repositories.length, state.enterCommitMode, state.leaveCommitMode]);
  useEffect(() => {
    if (!hasGit && state.activeTab !== "commit") state.setActiveTab("commit");
  }, [hasGit, state.activeTab, state.setActiveTab]);
  const selectPreview = (file: ChangeFile) => {
    const sequence = ++selectSequence.current;
    state.highlightFile(fileKey(file), "single");
    void changeAction(async () => {
      await select(file.repositoryId, "commit");
      if (sequence === selectSequence.current) setPreviewKey(fileKey(file));
    });
  };
  const switchTab = async (tab: "commit" | "shelf" | "stash") => {
    if (tab !== "commit") {
      const git =
        current?.kind === "git"
          ? current
          : repositories.find((repo) => repo.kind === "git");
      if (!git) return;
      await select(git.id, "commit");
      await Promise.all([state.fetchShelves(), state.fetchIdeaShelves()]);
    }
    state.setActiveTab(tab);
  };
  const resize = (pixels: number) =>
    setRatio(
      Math.max(
        220 / Math.max(1, width - 31),
        Math.min(pixels / (width - 31), 1 - 300 / Math.max(1, width - 31)),
      ),
    );
  return (
    <div
      ref={container}
      className={`commit-tab-content local-changes ${wide ? "wide" : "narrow"} ${state.commitMode ? "committing" : "browsing"}`}
    >
      {!repositories.length ? (
        <div className="changes-empty">
          {t("No Git or CVS repositories found in this workspace.")}
        </div>
      ) : (
        <div
          className={`changes-workbench ${wide && preview ? "with-preview" : ""}`}
          style={
            wide && preview
              ? {
                  gridTemplateColumns: `30px minmax(0, ${ratio}fr) 1px minmax(0, ${1 - ratio}fr)`,
                }
              : undefined
          }
        >
          <Toolbar
            hasGit={hasGit}
            gitSelected={current?.kind === "git"}
            hasChanges={state.changes.some(canCommit)}
            previewVisible={preview}
            onTogglePreview={() => setPreview((value) => !value)}
            onRefresh={() =>
              void changeAction(() => bridge.request("refreshRepositories"))
            }
            onShelve={() =>
              void changeAction(async () => {
                if (current?.kind !== "git") return;
                const keys = state.commitMode
                  ? state.selectedFiles
                  : state.highlightedFiles;
                const selected = state.changes.filter(
                  (file) =>
                    file.repositoryId === current.id &&
                    keys.has(fileKey(file)) &&
                    canCommit(file),
                );
                if (selected.length)
                  await bridge.request("ideaShelveChanges", {
                    repositoryId: current.id,
                    message: t("Shelved changes"),
                    filePaths: selected.map((file) => file.path),
                  });
              })
            }
            onRollback={() =>
              void changeAction(async () => {
                const selected = state.changes.filter(
                  (file) =>
                    file.repositoryId === currentId &&
                    state.highlightedFiles.has(fileKey(file)) &&
                    !["incoming", "untracked"].includes(file.status),
                );
                if (selected.length)
                  await bridge.request("openRollbackPanel", {
                    repositoryId: currentId,
                    files: selected.map(({ path, status, staged }) => ({
                      path,
                      status,
                      staged,
                    })),
                  });
              })
            }
          />
          <div className="changes-tree-pane">
            {hasGit && (
              <div
                className="changes-tabs"
                role="tablist"
                aria-label={t("Local Changes")}
              >
                <button
                  type="button"
                  role="tab"
                  aria-selected={state.activeTab === "commit"}
                  onClick={() => void changeAction(() => switchTab("commit"))}
                >
                  {t("Changes")}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={state.activeTab === "shelf"}
                  onClick={() => void changeAction(() => switchTab("shelf"))}
                >
                  {t("Shelf")}
                </button>
                <button
                  type="button"
                  role="tab"
                  aria-selected={state.activeTab === "stash"}
                  onClick={() => void changeAction(() => switchTab("stash"))}
                >
                  {t("Stash")}
                </button>
              </div>
            )}
            {state.error && (
              <div className="repository-error" role="alert">
                {state.error}
              </div>
            )}
            {state.activeTab === "commit" ? (
              <>
                <ChangeTree onSelect={selectPreview} />
                {state.commitMode && <CommitMessageArea />}
              </>
            ) : (
              <div className="changes-shelf">
                <div className="shelf-repository">{current?.name}</div>
                {state.activeTab === "shelf" ? (
                  <IdeaShelfTab key={current?.id} />
                ) : (
                  <ShelfTab key={current?.id} />
                )}
              </div>
            )}
          </div>
          {wide && preview && (
            <>
              <div
                className="changes-splitter"
                role="separator"
                aria-label={t("Resize changes tree")}
                aria-orientation="vertical"
                aria-valuemin={220}
                aria-valuemax={Math.max(220, width - 331)}
                aria-valuenow={Math.round((width - 31) * ratio)}
                tabIndex={0}
                onKeyDown={(event) => {
                  if (["ArrowLeft", "ArrowRight"].includes(event.key)) {
                    event.preventDefault();
                    resize(
                      (width - 31) * ratio +
                        (event.key === "ArrowLeft" ? -20 : 20),
                    );
                  }
                }}
                onPointerDown={(event) =>
                  event.currentTarget.setPointerCapture(event.pointerId)
                }
                onPointerMove={(event) => {
                  if (event.currentTarget.hasPointerCapture(event.pointerId))
                    resize(
                      event.clientX -
                        (container.current?.getBoundingClientRect().left ?? 0) -
                        30,
                    );
                }}
                onPointerUp={(event) =>
                  event.currentTarget.releasePointerCapture(event.pointerId)
                }
              />
              <DiffPreview file={file} files={files} onSelect={selectPreview} />
            </>
          )}
        </div>
      )}
    </div>
  );
}
