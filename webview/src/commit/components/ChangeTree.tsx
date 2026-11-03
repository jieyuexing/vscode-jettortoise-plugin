import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { IconFolder } from "../../panel/utils/file-icons";
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
import { ToolbarButton } from "./Toolbar";

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
  const groups = useMemo(
    () => groupChanges(repositories, snapshots),
    [repositories, snapshots],
  );
  const treeRef = useRef<HTMLDivElement>(null);
  const pendingFocus = useRef<number | undefined>(undefined);
  const activeIndex = useRef(-1);
  const [viewport, setViewport] = useState({
    top: 0,
    height: 400,
    rowHeight: 20,
  });
  useEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const resize = () =>
      setViewport((value) => ({
        ...value,
        height: tree.clientHeight || 400,
        rowHeight:
          Number.parseFloat(
            getComputedStyle(tree).getPropertyValue("--etech-row-height"),
          ) || 20,
      }));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(tree);
    return () => observer.disconnect();
  }, []);
  const [icons, setIcons] = useState<
    Record<string, { light: string; dark: string } | null>
  >({});
  const pendingIcons = useRef(new Set<string>());
  const iconGeneration = useRef(0);
  useEffect(
    () =>
      bridge.onEvent((event) => {
        if (event === "fileIconsChanged") {
          iconGeneration.current++;
          pendingIcons.current.clear();
          setIcons({});
        }
      }),
    [],
  );
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
        className={`changes-row ${category ? "category" : key.startsWith("repository:") ? "repository" : "directory"}`}
        style={{
          paddingInlineStart: `calc(var(--changes-base-inset, 6px) + ${level} * var(--etech-indent))`,
        }}
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
        {key.startsWith("directory:") && <IconFolder />}
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
            style={{
              paddingInlineStart: `calc(var(--changes-base-inset, 6px) + ${level} * var(--etech-indent))`,
            }}
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
        </div>
      );
    }
    return (
      <div
        key={key}
        style={{
          paddingInlineStart: `calc(var(--changes-base-inset, 6px) + ${level} * var(--etech-indent))`,
        }}
        className={`changes-file-row ${state.highlightedFiles.has(key) ? "selected" : ""}`}
      >
        <FileItem
          file={file}
          icon={icons[file.path]}
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
  const rows = useMemo(() => {
    const result: {
      key: string;
      level: number;
      file?: ChangeFile;
      label?: string;
      files?: ChangeFile[];
      content?: React.ReactNode;
      category?: boolean;
      notice?: string;
    }[] = [];
    const addFile = (file: ChangeFile, level: number) => {
      const key = fileKey(file);
      result.push({ key, file, level });
      if (file.directory && state.expandedGroups.has(`lazy:${key}`))
        for (const child of lazy[key] ?? []) addFile(child, level + 1);
    };
    const addRepos = (kind: "changes" | "unversioned" | "incoming") => {
      for (const group of groups) {
        if (
          !group[kind].length &&
          !(
            kind === "changes" &&
            (group.error || group.refreshing || group.syncedAt !== undefined)
          )
        )
          continue;
        const key = `repository:${kind}:${group.id}`;
        const branch = snapshots.find(
          (snapshot) => snapshot.repositoryId === group.id,
        )?.branch;
        result.push({
          key,
          level: 1,
          label: group.name,
          files: group[kind],
          content: (
            <>
              <span className="changes-tag">
                {group.kind === "git" ? "Git" : "CVS"}
              </span>
              <span className="changes-count">
                {fileCount(group[kind].length)}
              </span>
              {branch && <span className="changes-branch">{branch}</span>}
              {group.kind === "cvs" && group.syncedAt !== undefined && (
                <>
                  <span className="changes-synced-at">
                    {t(
                      "Synchronized at {0}",
                      new Date(group.syncedAt).toLocaleTimeString([], {
                        hour: "2-digit",
                        minute: "2-digit",
                        hour12: false,
                      }),
                    )}
                  </span>
                  <ToolbarButton
                    label={t("Remove from synchronization")}
                    path="M4 4l8 8M12 4l-8 8"
                    className="changes-remove-sync"
                    action={() =>
                      void changeAction(() =>
                        bridge.request("removeSynchronizedRepository", {
                          repositoryId: group.id,
                        }),
                      )
                    }
                  />
                </>
              )}
            </>
          ),
        });
        if (group.error)
          result.push({ key: `error:${key}`, level: 1, notice: group.error });
        if (group.refreshing)
          result.push({
            key: `progress:${key}`,
            level: 1,
            notice: t("Checking remote updates…"),
          });
        if (state.collapsedDirs.has(key)) continue;
        if (kind === "changes" && state.groupByDirectory) {
          for (const file of group.rootFiles) addFile(file, 2);
          for (const directory of group.directories) {
            const dirKey = `directory:${group.id}:${directory.path}`;
            result.push({
              key: dirKey,
              level: 2,
              label: directory.path,
              files: directory.files,
              content: (
                <span className="changes-count">
                  {fileCount(directory.files.length)}
                </span>
              ),
            });
            if (!state.collapsedDirs.has(dirKey))
              for (const file of directory.files) addFile(file, 3);
          }
        } else for (const file of group[kind]) addFile(file, 2);
      }
    };
    for (const [kind, label] of [
      ["changes", t("Changes")],
      ["unversioned", t("Unversioned Files")],
      ["ignored", t("Ignored")],
      ["incoming", t("Incoming")],
    ] as const) {
      const files =
        kind === "ignored" ? [] : groups.flatMap((group) => group[kind]);
      if (kind === "incoming" && !files.length) continue;
      result.push({
        key: kind,
        label,
        files: kind === "changes" ? files : [],
        level: 0,
        category: true,
        content:
          kind === "ignored" ? undefined : (
            <span className="changes-count">{fileCount(files.length)}</span>
          ),
      });
      if (!state.expandedGroups.has(kind)) continue;
      if (kind === "ignored")
        result.push({
          key: "ignored-notice",
          level: 0,
          notice: t("Ignored files are excluded from the change scan."),
        });
      else addRepos(kind);
    }
    return result;
  }, [
    groups,
    snapshots,
    state.expandedGroups,
    state.collapsedDirs,
    state.groupByDirectory,
    lazy,
  ]);
  const start = Math.max(
    0,
    Math.min(
      rows.length - 1,
      Math.floor((viewport.top - 4) / viewport.rowHeight) - 6,
    ),
  );
  const end = Math.min(
    rows.length,
    Math.ceil((viewport.top + viewport.height) / viewport.rowHeight) + 6,
  );
  const visibleIconPaths = rows
    .slice(start, end)
    .flatMap((item) =>
      item.file && !item.file.directory ? [item.file.path] : [],
    );
  const iconPathKey = JSON.stringify(visibleIconPaths);
  useEffect(() => {
    const paths = (JSON.parse(iconPathKey) as string[]).filter(
      (name) => !Object.hasOwn(icons, name) && !pendingIcons.current.has(name),
    );
    if (!paths.length) return;
    for (const name of paths) pendingIcons.current.add(name);
    const generation = iconGeneration.current;
    void bridge
      .request("getFileIcons", { filePaths: paths })
      .then(
        (data) => {
          if (generation !== iconGeneration.current) return;
          const result =
            data && !Array.isArray(data) && typeof data === "object"
              ? (data as Record<string, { light: string; dark: string } | null>)
              : {};
          setIcons((value) => ({
            ...value,
            ...Object.fromEntries(
              paths.map((name) => [name, result[name] ?? null]),
            ),
          }));
        },
        () => {
          if (generation === iconGeneration.current)
            setIcons((value) => ({
              ...value,
              ...Object.fromEntries(paths.map((name) => [name, null])),
            }));
        },
      )
      .finally(() => {
        if (generation === iconGeneration.current)
          for (const name of paths) pendingIcons.current.delete(name);
      });
  }, [iconPathKey, icons]);
  useLayoutEffect(() => {
    const index = pendingFocus.current;
    if (index === undefined) return;
    const element = treeRef.current?.querySelector<HTMLElement>(
      `[data-row-index="${index}"] .commit-file-item,[data-row-index="${index}"] .changes-row-label`,
    );
    if (element) {
      element.focus({ preventScroll: true });
      pendingFocus.current = undefined;
    }
  });
  useLayoutEffect(() => {
    const tree = treeRef.current;
    if (!tree) return;
    const max = Math.max(
      0,
      rows.length * viewport.rowHeight + 8 - viewport.height,
    );
    if (viewport.top > max) {
      tree.scrollTop = max;
      setViewport((value) => ({ ...value, top: max }));
    }
  }, [rows.length, viewport.height, viewport.top, viewport.rowHeight]);
  return (
    <div
      ref={treeRef}
      className="changes-tree"
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        setViewport((value) => ({ ...value, top }));
      }}
      onFocusCapture={(event) => {
        const wrapper = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-row-index]",
        );
        if (wrapper) activeIndex.current = Number(wrapper.dataset.rowIndex);
      }}
      aria-label={t("Changed Files")}
      onKeyDown={(event) => {
        if (
          !["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) ||
          (event.target as HTMLElement).tagName === "INPUT"
        )
          return;
        let index =
          event.key === "Home"
            ? 0
            : event.key === "End"
              ? rows.length - 1
              : Math.max(
                  0,
                  Math.min(
                    rows.length - 1,
                    activeIndex.current + (event.key === "ArrowDown" ? 1 : -1),
                  ),
                );
        const direction =
          event.key === "ArrowUp" || event.key === "End" ? -1 : 1;
        while (rows[index]?.notice && index >= 0 && index < rows.length)
          index += direction;
        if (!rows[index]) return;
        event.preventDefault();
        activeIndex.current = index;
        pendingFocus.current = index;
        const tree = event.currentTarget;
        const top = index * viewport.rowHeight + 4;
        const next =
          top < viewport.top
            ? top - 4
            : top + viewport.rowHeight > viewport.top + viewport.height
              ? top + viewport.rowHeight - viewport.height
              : viewport.top;
        tree.scrollTop = next;
        setViewport((value) => ({ ...value, top: next }));
      }}
    >
      <div
        style={{
          height: rows.length * viewport.rowHeight,
          position: "relative",
        }}
      >
        {rows.slice(start, end).map((item, offset) => (
          <div
            key={item.key}
            data-row-index={start + offset}
            style={{
              position: "absolute",
              top: (start + offset) * viewport.rowHeight,
              height: viewport.rowHeight,
              width: "100%",
            }}
          >
            {item.file ? (
              fileRow(item.file, item.level)
            ) : item.notice ? (
              <div
                className={
                  item.key.startsWith("error:")
                    ? "repository-error"
                    : "repository-progress"
                }
                title={item.notice}
              >
                {item.notice}
              </div>
            ) : (
              row(
                item.key,
                item.label ?? "",
                item.files ?? [],
                item.level,
                item.content,
                item.category,
              )
            )}
          </div>
        ))}
      </div>
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
