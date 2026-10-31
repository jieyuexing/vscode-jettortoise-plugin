import { useState } from "react";
import { bridge } from "../../shared/bridge";
import { fileCount, t } from "../../shared/i18n";
import {
  type ChangeFile,
  canCommit,
  fileKey,
  groupChanges,
} from "../../shared/models/changes";
import { useCommitStore } from "../../shared/store/commit-store";
import { useRepositoryStore } from "../../shared/store/repository-store";
import { CommitFileContextMenu } from "./CommitFileContextMenu";
import { FileItem } from "./FileItem";

export async function changeAction(fn: () => Promise<unknown>) {
  try {
    useCommitStore.setState({ error: undefined });
    await fn();
  } catch (error) {
    useCommitStore.setState({
      error: error instanceof Error ? error.message : t("Operation failed."),
    });
  }
}
export async function showWorkingDiff(file: ChangeFile) {
  await useRepositoryStore.getState().select(file.repositoryId, "commit");
  return bridge.request(
    file.status === "untracked" ? "openFile" : "showDiffForWorkingFile",
    {
      repositoryId: file.repositoryId,
      filePath: file.path,
      ...(file.status === "untracked" ? {} : { staged: file.staged }),
    },
  );
}
export function ChangeTree({
  onSelect,
}: {
  onSelect: (file: ChangeFile) => void;
}) {
  const { repositories, snapshots } = useRepositoryStore();
  const state = useCommitStore();
  const groups = groupChanges(repositories, snapshots);
  const [menu, setMenu] = useState<{
    x: number;
    y: number;
    file: ChangeFile;
  } | null>(null);
  const [lazy, setLazy] = useState<Record<string, ChangeFile[]>>({});
  const checkbox = (files: ChangeFile[], label: string) => {
    if (!state.commitMode) return null;
    const keys = files.filter(canCommit).map(fileKey);
    return (
      <input
        type="checkbox"
        aria-label={label}
        checked={
          keys.length > 0 && keys.every((key) => state.selectedFiles.has(key))
        }
        disabled={!keys.length || state.loading}
        onChange={(event) => state.setFileKeys(keys, event.target.checked)}
      />
    );
  };
  const openMenu = (event: React.MouseEvent, file: ChangeFile) => {
    event.preventDefault();
    event.stopPropagation();
    void changeAction(() =>
      useRepositoryStore.getState().select(file.repositoryId, "commit"),
    );
    setMenu({ x: event.clientX, y: event.clientY, file });
  };
  const row = (
    key: string,
    label: string,
    files: ChangeFile[],
    level: number,
    content?: React.ReactNode,
    category = false,
  ) => {
    const open = category
      ? state.expandedGroups.has(key)
      : !state.collapsedDirs.has(key);
    return (
      <div
        className="changes-row"
        style={{ paddingInlineStart: 6 + level * 14 }}
      >
        <button
          type="button"
          className="changes-twisty"
          aria-label={label}
          aria-expanded={open}
          onClick={() =>
            category ? state.toggleGroup(key) : state.toggleDir(key)
          }
        >
          <Chevron open={open} />
        </button>
        {checkbox(files, t("Select {0}", label))}
        <button
          type="button"
          className="changes-row-label"
          onClick={() =>
            category ? state.toggleGroup(key) : state.toggleDir(key)
          }
        >
          {label}
        </button>
        {content}
      </div>
    );
  };
  const fileRow = (file: ChangeFile, level: number) => {
    const key = fileKey(file);
    if (file.directory) {
      const open = state.expandedGroups.has(`lazy:${key}`);
      return (
        <div key={key}>
          <div
            className="changes-row"
            style={{ paddingInlineStart: 6 + level * 14 }}
          >
            <button
              type="button"
              className="changes-row-label"
              aria-expanded={open}
              onContextMenu={(event) => openMenu(event, file)}
              onClick={() =>
                void changeAction(async () => {
                  if (!open) {
                    const nodes = (await bridge.request("expandUnversioned", {
                      repositoryId: file.repositoryId,
                      filePath: file.path,
                    })) as ChangeFile[];
                    setLazy((value) => ({ ...value, [key]: nodes }));
                  }
                  state.toggleGroup(`lazy:${key}`);
                })
              }
            >
              <Chevron open={open} />
              {file.path.split("/").pop()}
            </button>
          </div>
          {open && lazy[key]?.map((child) => fileRow(child, level + 1))}
        </div>
      );
    }
    return (
      <div
        key={key}
        style={{ paddingInlineStart: 6 + level * 14 }}
        className={`changes-file-row ${state.highlightedFiles.has(key) ? "selected" : ""}`}
      >
        <FileItem
          file={file}
          selected={state.selectedFiles.has(key)}
          highlighted={state.highlightedFiles.has(key)}
          showCheckbox={state.commitMode}
          showPath={!state.groupByDirectory}
          onToggle={() => state.toggleFileSelection(key)}
          onShowDiff={() => void changeAction(() => showWorkingDiff(file))}
          onContextMenu={(event) => openMenu(event, file)}
          onClick={(event) => {
            state.highlightFile(
              key,
              event.metaKey || event.ctrlKey ? "toggle" : "single",
            );
            onSelect(file);
          }}
        />
      </div>
    );
  };
  const repoRows = (kind: "changes" | "unversioned" | "incoming") =>
    groups
      .filter(
        (group) =>
          group[kind].length ||
          (kind === "changes" && (group.error || group.refreshing)),
      )
      .map((group) => {
        const key = `repository:${kind}:${group.id}`;
        const open = !state.collapsedDirs.has(key);
        const branch = snapshots.find(
          (snapshot) => snapshot.repositoryId === group.id,
        )?.branch;
        return (
          <section key={group.id} aria-label={`${group.name} ${group.kind}`}>
            {row(
              key,
              group.name,
              group[kind],
              1,
              <>
                <span className="changes-tag">
                  {group.kind === "git" ? "Git" : "CVS"}
                </span>
                <span className="changes-count">
                  {fileCount(group[kind].length)}
                </span>
                {branch && <span className="changes-branch">{branch}</span>}
              </>,
            )}
            {group.error && (
              <div className="repository-error" role="alert">
                {group.error}
              </div>
            )}
            {group.refreshing && (
              <div className="repository-progress" role="status">
                {t("Checking remote updates…")}
              </div>
            )}
            {open &&
              (kind === "changes" && state.groupByDirectory ? (
                <>
                  {group.rootFiles.map((file) => fileRow(file, 2))}
                  {group.directories.map((directory) => {
                    const dirKey = `directory:${group.id}:${directory.path}`;
                    return (
                      <div key={dirKey}>
                        {row(
                          dirKey,
                          directory.path,
                          directory.files,
                          2,
                          <span className="changes-count">
                            {fileCount(directory.files.length)}
                          </span>,
                        )}
                        {!state.collapsedDirs.has(dirKey) &&
                          directory.files.map((file) => fileRow(file, 3))}
                      </div>
                    );
                  })}
                </>
              ) : (
                group[kind].map((file) => fileRow(file, 2))
              ))}
          </section>
        );
      });
  const allChanges = groups.flatMap((group) => group.changes);
  const unversioned = groups.flatMap((group) => group.unversioned);
  const incoming = groups.flatMap((group) => group.incoming);
  return (
    <div
      className="changes-tree"
      aria-label={t("Changed Files")}
      onKeyDown={(event) => {
        if (
          !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
          (event.target as HTMLElement).tagName === "INPUT"
        )
          return;
        const elements = Array.from(
          event.currentTarget.querySelectorAll<HTMLElement>(
            ".commit-file-item,.changes-row-label",
          ),
        );
        const current = elements.indexOf(document.activeElement as HTMLElement);
        const index =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? elements.length - 1
              : Math.max(
                  0,
                  Math.min(
                    elements.length - 1,
                    current + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                );
        event.preventDefault();
        elements[index]?.focus();
        elements[index]?.scrollIntoView({ block: "nearest" });
      }}
    >
      {row(
        "changes",
        t("Changes"),
        allChanges,
        0,
        <span className="changes-count">{fileCount(allChanges.length)}</span>,
        true,
      )}
      {state.expandedGroups.has("changes") && repoRows("changes")}
      {row(
        "unversioned",
        t("Unversioned Files"),
        [],
        0,
        <span className="changes-count">{fileCount(unversioned.length)}</span>,
        true,
      )}
      {state.expandedGroups.has("unversioned") && repoRows("unversioned")}
      {row("ignored", t("Ignored"), [], 0, undefined, true)}
      {state.expandedGroups.has("ignored") && (
        <div className="changes-tree-notice">
          {t("Ignored files are excluded from the change scan.")}
        </div>
      )}
      {incoming.length > 0 && (
        <>
          {row(
            "incoming",
            t("Incoming"),
            [],
            0,
            <span className="changes-count">{fileCount(incoming.length)}</span>,
            true,
          )}
          {state.expandedGroups.has("incoming") && repoRows("incoming")}
        </>
      )}
      {menu && (
        <CommitFileContextMenu {...menu} onClose={() => setMenu(null)} />
      )}
    </div>
  );
}
function Chevron({ open }: { open: boolean }) {
  return (
    <svg
      className={`changes-chevron ${open ? "open" : ""}`}
      viewBox="0 0 12 12"
      width="12"
      height="12"
      fill="none"
      aria-hidden="true"
    >
      <path d="m4 3 3 3-3 3" stroke="currentColor" strokeLinecap="round" />
    </svg>
  );
}
