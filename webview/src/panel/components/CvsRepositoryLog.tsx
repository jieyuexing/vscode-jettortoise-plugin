import {
  type KeyboardEvent,
  useCallback,
  useEffect,
  useRef,
  useState,
} from "react";
import { bridge } from "../../shared/bridge";
import { fileCount, t } from "../../shared/i18n";
import { useRepositoryStore } from "../../shared/store/repository-store";

interface LogCommit {
  id: string;
  time: number;
  author: string;
  subject: string;
  body: string;
  fileCount: number;
}
interface LogFile {
  path: string;
  revision: string;
  previous?: string;
  kind: "added" | "modified" | "deleted";
  /** 本地工作副本里有这个文件（缺省按有处理）。 */
  local?: boolean;
}
interface LogResult {
  commits: LogCommit[];
  cachedAt?: number;
  fromCache?: boolean;
  error?: string;
}
const ROW_HEIGHT = 20;
const OVERSCAN = 6;

function formatClock(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
function formatTime(time: number): string {
  const date = new Date(time);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}
// 目录与文件名分开：窄栏里目录部分先省略，文件名保持可见。
const directoryOf = (path: string) => path.slice(0, path.lastIndexOf("/") + 1);
const nameOf = (path: string) => path.slice(path.lastIndexOf("/") + 1);
function revisionChange(file: LogFile): string {
  if (file.kind === "added") return t("New {0}", file.revision);
  if (file.kind === "deleted") return t("Deleted {0}", file.revision);
  return `${file.previous} → ${file.revision}`;
}

/** 只挂载视口及前后几行的定高列表：导入提交可有上万个文件。 */
function useWindow(count: number) {
  const ref = useRef<HTMLDivElement>(null);
  const [range, setRange] = useState({ start: 0, end: 40 });
  const update = useCallback(() => {
    const node = ref.current;
    if (!node) return;
    const height = node.clientHeight || 400;
    const start = Math.max(
      0,
      Math.floor(node.scrollTop / ROW_HEIGHT) - OVERSCAN,
    );
    const end = Math.min(
      count,
      Math.ceil((node.scrollTop + height) / ROW_HEIGHT) + OVERSCAN,
    );
    setRange((previous) =>
      previous.start === start && previous.end === end
        ? previous
        : { start, end },
    );
  }, [count]);
  useEffect(() => {
    update();
    const node = ref.current;
    if (!node || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(node);
    return () => observer.disconnect();
  }, [update]);
  return { ref, range, update };
}

/**
 * CVS 仓库级提交列表：左侧日期、作者、说明、文件数，右侧所选提交的文件及修订变化。
 * 只在打开（日志可见）、切换范围、加载更早、刷新时向宿主取；宿主按窗口缓存。
 */
export function CvsRepositoryLog({
  repositoryId,
  days,
  refreshToken,
  onLoadEarlier,
  onShowFileHistory,
}: {
  repositoryId: string;
  days: number;
  refreshToken: number;
  onLoadEarlier: () => void;
  onShowFileHistory: (file: string) => void;
}) {
  const visible = useRepositoryStore((state) => state.visible);
  const [commits, setCommits] = useState<LogCommit[]>([]);
  const [loaded, setLoaded] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [selected, setSelected] = useState<string>();
  const [files, setFiles] = useState<LogFile[]>([]);
  const [cachedAt, setCachedAt] = useState<number>();
  const [menu, setMenu] = useState<{ file: LogFile; x: number; y: number }>();
  const generation = useRef(0);
  const filesGeneration = useRef(0);
  const selectedRef = useRef<string | undefined>(undefined);
  const seenRefresh = useRef(refreshToken);
  const list = useWindow(commits.length);
  const detail = useWindow(files.length);

  // 选中一行并向宿主取其文件（取自宿主已缓存的列表，不连服务器）。
  const choose = useCallback(
    (commitId: string | undefined) => {
      selectedRef.current = commitId;
      setSelected(commitId);
      const current = ++filesGeneration.current;
      if (!commitId) {
        setFiles([]);
        return;
      }
      void bridge
        .request("getCvsCommit", { repositoryId, commitId })
        .then((result) => {
          if (current === filesGeneration.current)
            setFiles(result as LogFile[]);
        })
        .catch((failure) => {
          if (current === filesGeneration.current) setError(String(failure));
        });
    },
    [repositoryId],
  );

  // 打开、切换范围时先显示缓存（不连服务器），再向宿主取增量；刷新直接取增量。
  useEffect(() => {
    if (!visible) return;
    const refresh = refreshToken !== seenRefresh.current;
    seenRefresh.current = refreshToken;
    const current = ++generation.current;
    const show = (result: LogResult) => {
      setCommits(result.commits);
      setCachedAt(result.fromCache ? result.cachedAt : undefined);
      setError(result.error ?? "");
      setLoaded(true);
      choose(
        result.commits.some((commit) => commit.id === selectedRef.current)
          ? selectedRef.current
          : result.commits[0]?.id,
      );
    };
    setLoading(true);
    setError("");
    void (async () => {
      if (!refresh) {
        const cached = (await bridge.request("getCvsLog", {
          repositoryId,
          days,
          cached: true,
        })) as LogResult;
        if (current !== generation.current) return;
        if (cached.cachedAt !== undefined) show(cached);
      }
      const result = (await bridge.request(
        "getCvsLog",
        refresh
          ? { repositoryId, days, refresh: true }
          : { repositoryId, days },
      )) as LogResult;
      if (current === generation.current) show(result);
    })()
      .catch((failure) => {
        if (current === generation.current) setError(String(failure));
      })
      .finally(() => {
        if (current === generation.current) setLoading(false);
      });
    return () => {
      generation.current++;
    };
  }, [repositoryId, days, refreshToken, visible, choose]);

  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(undefined);
    const onKey = (event: globalThis.KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    window.addEventListener("click", close);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("click", close);
      window.removeEventListener("keydown", onKey);
    };
  }, [menu]);

  const move = (event: KeyboardEvent) => {
    const offset =
      event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
    if (!offset || !commits.length) return;
    event.preventDefault();
    const index = commits.findIndex((commit) => commit.id === selected);
    const next = Math.min(commits.length - 1, Math.max(0, index + offset));
    choose(commits[next].id);
    const node = list.ref.current;
    if (!node) return;
    if (next * ROW_HEIGHT < node.scrollTop) node.scrollTop = next * ROW_HEIGHT;
    else if ((next + 1) * ROW_HEIGHT > node.scrollTop + node.clientHeight)
      node.scrollTop = (next + 1) * ROW_HEIGHT - node.clientHeight;
  };

  const commit = commits.find((item) => item.id === selected);
  return (
    <div className="cvs-repo-log">
      <div className="cvs-log-list">
        <div className="cvs-log-head" role="row">
          <span>{t("Date")}</span>
          <span>{t("Author")}</span>
          <span>{t("Message")}</span>
          <span>{t("Files")}</span>
        </div>
        {loading && (
          <div role="status" className="repository-empty">
            {t("Loading commits…")}
          </div>
        )}
        {error && (
          <div className="repository-error" role="alert">
            {error}
          </div>
        )}
        {cachedAt !== undefined && (
          <div className="cvs-log-cached" role="status">
            {t("Cached at {0}", formatClock(cachedAt))}
          </div>
        )}
        {loaded && !loading && !error && commits.length === 0 && (
          <div className="repository-empty">
            {t("No commits in this range.")}
          </div>
        )}
        <div
          className="cvs-log-scroll"
          ref={list.ref}
          tabIndex={0}
          role="listbox"
          aria-label={t("Commits")}
          onScroll={list.update}
          onKeyDown={move}
        >
          <div
            style={{
              height: commits.length * ROW_HEIGHT,
              position: "relative",
            }}
          >
            {commits
              .slice(list.range.start, list.range.end)
              .map((item, index) => (
                <div
                  key={item.id}
                  role="row"
                  aria-selected={item.id === selected}
                  className="cvs-log-row"
                  style={{ top: (list.range.start + index) * ROW_HEIGHT }}
                  title={
                    item.body ? `${item.subject}\n${item.body}` : item.subject
                  }
                  onClick={() => choose(item.id)}
                >
                  <span>{formatTime(item.time)}</span>
                  <span>{item.author}</span>
                  <span>{item.subject}</span>
                  <span className="cvs-log-count">{item.fileCount}</span>
                </div>
              ))}
          </div>
          {days !== 0 && loaded && (
            <button
              type="button"
              className="cvs-log-more"
              disabled={loading}
              onClick={onLoadEarlier}
            >
              {t("Load earlier…")}
            </button>
          )}
        </div>
      </div>
      <div className="cvs-log-detail">
        {commit ? (
          <>
            <h4 title={commit.body || commit.subject}>{commit.subject}</h4>
            <div className="cvs-log-meta">
              {commit.author} · {formatTime(commit.time)} ·{" "}
              {fileCount(commit.fileCount)}
            </div>
            <div
              className="cvs-log-files"
              ref={detail.ref}
              onScroll={detail.update}
            >
              <div
                style={{
                  height: files.length * ROW_HEIGHT,
                  position: "relative",
                }}
              >
                {files
                  .slice(detail.range.start, detail.range.end)
                  .map((file, index) => (
                    <button
                      key={file.path}
                      type="button"
                      className="cvs-log-file"
                      style={{ top: (detail.range.start + index) * ROW_HEIGHT }}
                      title={file.path}
                      onClick={() =>
                        void bridge
                          .request("diffCvsRevision", {
                            repositoryId,
                            filePath: file.path,
                            revision: file.revision,
                          })
                          .catch((failure) => setError(String(failure)))
                      }
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setMenu({
                          file,
                          x: event.clientX,
                          y: event.clientY,
                        });
                      }}
                    >
                      <span className="cvs-log-path">
                        <span className="cvs-log-dir">
                          {directoryOf(file.path)}
                        </span>
                        <span className="cvs-log-name">
                          {nameOf(file.path)}
                        </span>
                      </span>
                      {file.local === false && (
                        <span
                          className="cvs-log-missing"
                          title={t(
                            "Not in the working copy. Update the project first.",
                          )}
                        >
                          {t("Not local")}
                        </span>
                      )}
                      <span className="cvs-log-revision">
                        {revisionChange(file)}
                      </span>
                    </button>
                  ))}
              </div>
            </div>
          </>
        ) : (
          <div className="repository-empty">
            {t("Select a commit to see changed files")}
          </div>
        )}
      </div>
      {menu && (
        <div
          role="menu"
          className="cvs-log-menu"
          style={{ left: menu.x, top: menu.y }}
        >
          {[
            {
              label: t("Open File"),
              local: true,
              run: () =>
                bridge.request("openFile", {
                  repositoryId,
                  filePath: menu.file.path,
                }),
            },
            {
              label: t("Compare with Working Copy"),
              local: true,
              run: () =>
                bridge.request("compareCvsWorkingFile", {
                  repositoryId,
                  filePath: menu.file.path,
                  revision: menu.file.revision,
                }),
            },
            {
              label: t("Show history of this file"),
              local: false,
              run: () => onShowFileHistory(menu.file.path),
            },
          ].map((item) => {
            // 需要本地文件的项在“本地没有”时置灰，并提示先更新。
            const disabled = item.local && menu.file.local === false;
            return (
              <button
                key={item.label}
                type="button"
                role="menuitem"
                disabled={disabled}
                title={
                  disabled
                    ? t("Not in the working copy. Update the project first.")
                    : undefined
                }
                onClick={() =>
                  void Promise.resolve(item.run()).catch((failure) =>
                    setError(String(failure)),
                  )
                }
              >
                {item.label}
              </button>
            );
          })}
        </div>
      )}
    </div>
  );
}
