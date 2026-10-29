import { useCallback, useMemo, useState } from "react";
import { bridge } from "../../shared/bridge";
import {
  type ChangeFile,
  canCommit,
  fileKey,
  groupChanges,
} from "../../shared/models/changes";
import { useCommitStore } from "../../shared/store/commit-store";
import { useRepositoryStore } from "../../shared/store/repository-store";
import { CommitFileContextMenu } from "./CommitFileContextMenu";
import { CommitMessageArea } from "./CommitMessageArea";
import { FileItem } from "./FileItem";
import { Toolbar } from "./Toolbar";

export function CommitTab() {
  const {
    repositories,
    snapshots,
    commitRepositoryId,
    logRepositoryId,
    select,
  } = useRepositoryStore();
  const {
    changes,
    selectedFiles,
    highlightedFiles,
    toggleFileSelection,
    highlightFile,
    setFileKeys,
    expandedGroups,
    toggleGroup,
    collapsedDirs,
    toggleDir,
    groupByDirectory,
    showUnversioned,
    error,
  } = useCommitStore();
  const groups = useMemo(
    () => groupChanges(repositories, snapshots),
    [repositories, snapshots],
  );
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    file: ChangeFile;
  } | null>(null);
  const [lazy, setLazy] = useState<Record<string, ChangeFile[]>>({});
  const [lazyErrors, setLazyErrors] = useState<Record<string, string>>({});
  const currentId = commitRepositoryId ?? logRepositoryId;
  const current = repositories.find((item) => item.id === currentId);
  const selected = changes.filter((file) => selectedFiles.has(fileKey(file)));
  const showDiff = useCallback(
    async (file: ChangeFile) => {
      await select(file.repositoryId, "commit");
      if (file.status === "untracked")
        await bridge.request("openFile", {
          repositoryId: file.repositoryId,
          filePath: file.path,
        });
      else
        await bridge.request("showDiffForWorkingFile", {
          repositoryId: file.repositoryId,
          filePath: file.path,
          staged: file.staged,
        });
    },
    [select],
  );
  const action = async (fn: () => Promise<unknown>) => {
    try {
      useCommitStore.setState({ error: undefined });
      await fn();
    } catch (error) {
      useCommitStore.setState({
        error: error instanceof Error ? error.message : "Operation failed.",
      });
    }
  };
  const openMenu = (event: React.MouseEvent, file: ChangeFile) => {
    event.preventDefault();
    event.stopPropagation();
    void select(file.repositoryId, "commit");
    setMenu({ x: event.clientX, y: event.clientY, file });
  };
  const renderFile = (file: ChangeFile): React.ReactNode => {
    const key = fileKey(file);
    if (file.directory) {
      const expanded = expandedGroups.has(`lazy:${key}`);
      return (
        <div key={key} className="commit-lazy-directory">
          <button
            type="button"
            className="commit-group-header"
            aria-expanded={expanded}
            onContextMenu={(event) => openMenu(event, file)}
            onClick={() =>
              void action(async () => {
                await select(file.repositoryId, "commit");
                if (!expanded) {
                  const nodes = (await bridge.request("expandUnversioned", {
                    repositoryId: file.repositoryId,
                    filePath: file.path,
                  })) as ChangeFile[];
                  setLazy((value) => ({ ...value, [key]: nodes }));
                  setLazyErrors((value) => ({ ...value, [key]: "" }));
                }
                toggleGroup(`lazy:${key}`);
              }).catch((error) =>
                setLazyErrors((value) => ({ ...value, [key]: String(error) })),
              )
            }
          >
            {expanded ? "▾" : "▸"} 📁 {file.path.split("/").pop()}
          </button>
          {lazyErrors[key] && <div role="alert">{lazyErrors[key]}</div>}
          {expanded && (
            <div className="commit-directory-children">
              {lazy[key]?.map(renderFile)}
            </div>
          )}
        </div>
      );
    }
    return (
      <FileItem
        key={key}
        file={file}
        selected={selectedFiles.has(key)}
        highlighted={highlightedFiles.has(key)}
        onToggle={() => toggleFileSelection(key)}
        onContextMenu={(event) => openMenu(event, file)}
        onShowDiff={() => void action(() => showDiff(file))}
        onClick={(event) => {
          highlightFile(
            key,
            event.metaKey || event.ctrlKey ? "toggle" : "single",
          );
          void action(() => showDiff(file));
        }}
      />
    );
  };
  return (
    <div
      className="commit-tab-content"
      style={{ display: "flex", flexDirection: "column", height: "100%" }}
    >
      <Toolbar
        onRefresh={() =>
          void action(() => bridge.request("refreshRepositories"))
        }
        onShelve={() =>
          void action(async () => {
            if (!current || current.kind !== "git") return;
            await bridge.request("ideaShelveChanges", {
              repositoryId: current.id,
              message: "Shelved changes",
              filePaths: selected
                .filter((file) => file.repositoryId === current.id)
                .map((file) => file.path),
            });
          })
        }
        onRollback={() =>
          void action(async () => {
            const files = changes.filter(
              (file) =>
                highlightedFiles.has(fileKey(file)) &&
                file.repositoryId === currentId &&
                !["incoming", "untracked"].includes(file.status),
            );
            if (files.length)
              await bridge.request("openRollbackPanel", {
                repositoryId: currentId,
                files: files.map(({ path, status, staged }) => ({
                  path,
                  status,
                  staged,
                })),
              });
          })
        }
        onDiff={() => {
          const file = changes.find((file) =>
            highlightedFiles.has(fileKey(file)),
          );
          if (file) void action(() => showDiff(file));
        }}
        hasChanges={
          !!current &&
          changes.some(
            (file) => file.repositoryId === current.id && canCommit(file),
          )
        }
        gitSelected={current?.kind === "git"}
      />
      {error && (
        <div className="repository-error" role="alert">
          {error}
        </div>
      )}
      <div className="commit-file-list">
        {groups.length === 0 && (
          <div className="repository-empty">
            No Git or CVS repositories found in this workspace.
          </div>
        )}
        {groups.map((group) => {
          const repositoryKey = `repository:${group.id}`;
          const expanded = !collapsedDirs.has(repositoryKey);
          const keys = group.changes.filter(canCommit).map(fileKey);
          return (
            <section
              key={group.id}
              className="commit-repository"
              aria-label={`${group.name} ${group.kind}`}
            >
              <div
                className={`commit-group-header repository-header ${currentId === group.id ? "active" : ""}`}
              >
                <button
                  type="button"
                  aria-expanded={expanded}
                  onClick={() => toggleDir(repositoryKey)}
                >
                  {expanded ? "▾" : "▸"}
                </button>
                <input
                  type="checkbox"
                  aria-label={`Select changes in ${group.name}`}
                  checked={
                    keys.length > 0 &&
                    keys.every((key) => selectedFiles.has(key))
                  }
                  disabled={!keys.length}
                  onChange={(event) => setFileKeys(keys, event.target.checked)}
                />
                <button
                  type="button"
                  className="repository-label"
                  title={group.root}
                  onClick={() => void select(group.id, "commit")}
                >
                  {group.name}{" "}
                  <span className="repository-kind">
                    {group.kind.toUpperCase()}
                  </span>{" "}
                  <span className="commit-group-count">
                    {group.count} {group.count === 1 ? "file" : "files"}
                  </span>
                </button>
              </div>
              {group.error && (
                <div className="repository-error" role="alert">
                  {group.error}
                </div>
              )}
              {group.refreshing && (
                <div className="repository-progress" role="status">
                  Checking remote updates…
                </div>
              )}
              {expanded && (
                <div className="commit-repository-contents">
                  {group.changes.length > 0 && (
                    <div className="commit-group-header">
                      Changes{" "}
                      <span className="commit-group-count">{group.count}</span>
                    </div>
                  )}
                  {groupByDirectory
                    ? group.directories.map((directory) => {
                        const key = `directory:${group.id}:${directory.path}`;
                        const open = !collapsedDirs.has(key);
                        return (
                          <div key={key}>
                            <div className="commit-group-header commit-directory-header">
                              <button
                                type="button"
                                aria-expanded={open}
                                onClick={() => toggleDir(key)}
                              >
                                {open ? "▾" : "▸"} {directory.path}
                              </button>
                              <input
                                type="checkbox"
                                aria-label={`Select ${directory.path}`}
                                disabled={!directory.files.some(canCommit)}
                                checked={
                                  directory.files.filter(canCommit).length >
                                    0 &&
                                  directory.files
                                    .filter(canCommit)
                                    .every((file) =>
                                      selectedFiles.has(fileKey(file)),
                                    )
                                }
                                onChange={(event) =>
                                  setFileKeys(
                                    directory.files
                                      .filter(canCommit)
                                      .map(fileKey),
                                    event.target.checked,
                                  )
                                }
                              />
                              <span className="commit-group-count">
                                {directory.files.length} files
                              </span>
                            </div>
                            {open && directory.files.map(renderFile)}
                          </div>
                        );
                      })
                    : group.changes.map(renderFile)}
                  {showUnversioned && group.unversioned.length > 0 && (
                    <div>
                      <button
                        type="button"
                        className="commit-group-header"
                        aria-expanded={expandedGroups.has(
                          `unversioned:${group.id}`,
                        )}
                        onClick={() => toggleGroup(`unversioned:${group.id}`)}
                      >
                        {expandedGroups.has(`unversioned:${group.id}`)
                          ? "▾"
                          : "▸"}{" "}
                        Unversioned Files
                      </button>
                      {expandedGroups.has(`unversioned:${group.id}`) &&
                        group.unversioned.map(renderFile)}
                    </div>
                  )}
                  {group.incoming.length > 0 && (
                    <div>
                      <button
                        type="button"
                        className="commit-group-header"
                        aria-expanded={expandedGroups.has(
                          `incoming:${group.id}`,
                        )}
                        onClick={() => toggleGroup(`incoming:${group.id}`)}
                      >
                        {expandedGroups.has(`incoming:${group.id}`) ? "▾" : "▸"}{" "}
                        Incoming
                      </button>
                      {expandedGroups.has(`incoming:${group.id}`) &&
                        group.incoming.map(renderFile)}
                    </div>
                  )}
                </div>
              )}
            </section>
          );
        })}
      </div>
      <CommitMessageArea />
      {menu && (
        <CommitFileContextMenu {...menu} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
