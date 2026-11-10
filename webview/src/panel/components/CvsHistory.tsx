import { useCallback, useEffect, useRef, useState } from "react";
import CodiconRefresh from "~icons/codicon/refresh";
import { bridge } from "../../shared/bridge";
import { PanelHeader } from "../../shared/components/PanelHeader";
import { ToolbarButton } from "../../shared/components/ToolbarButton";
import { t } from "../../shared/i18n";
import { useRepositoryStore } from "../../shared/store/repository-store";

interface Revision {
  revisionId: string;
  timestamp: string;
  author: { name: string };
  subject: string;
  body: string;
}
export function CvsHistory({
  repositoryId,
  activeFile,
  initialFile,
  requestId = 0,
}: {
  repositoryId: string;
  activeFile?: string;
  /** 从仓库日志的文件右键进入时先选中的文件，可以不在本地 Entries 里（同事新增的文件）。 */
  initialFile?: string;
  requestId?: number;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  // 自动选中的文件（当前编辑器或首个文件），日志可见时才查询其历史。
  const [pending, setPending] = useState("");
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const wantedFile = useRef(initialFile);
  const fileGeneration = useRef(0);
  const handledRequest = useRef(0);
  const latestRequest = useRef(requestId);
  latestRequest.current = requestId;
  const historyGeneration = useRef(0);
  const visible = useRepositoryStore((state) => state.visible);
  const scanPaused = useRepositoryStore(
    (state) =>
      state.snapshots.find((snapshot) => snapshot.repositoryId === repositoryId)
        ?.scanPaused,
  );
  const loadFiles = useCallback(async () => {
    const generation = ++fileGeneration.current;
    try {
      const names = (await bridge.request("getCvsFiles", {
        repositoryId,
      })) as string[];
      if (generation !== fileGeneration.current) return;
      setError("");
      const wanted = wantedFile.current;
      wantedFile.current = undefined;
      const options =
        wanted && !names.includes(wanted) ? [...names, wanted] : names;
      setFiles(options);
      // 返回值与选中项一致：指定文件优先，其次当前编辑器文件，其次保留原选择，否则首个文件。
      const name =
        wanted ??
        (activeFile && options.includes(activeFile)
          ? activeFile
          : options.includes(selectedRef.current)
            ? selectedRef.current
            : (options[0] ?? ""));
      selectedRef.current = name;
      setSelected(name);
      return name;
    } catch (error) {
      if (generation === fileGeneration.current) setError(String(error));
    }
  }, [repositoryId, activeFile]);
  const loadHistory = useCallback(
    async (name = selected) => {
      const generation = ++historyGeneration.current;
      if (!name) return;
      setLoading(true);
      setError("");
      setRevisions([]);
      try {
        const result = (await bridge.request("getCvsHistory", {
          repositoryId,
          filePath: name,
        })) as Revision[];
        if (generation === historyGeneration.current) setRevisions(result);
      } catch (error) {
        if (generation === historyGeneration.current) setError(String(error));
      } finally {
        if (generation === historyGeneration.current) setLoading(false);
      }
    },
    [repositoryId, selected],
  );
  useEffect(() => {
    historyGeneration.current++;
    setRevisions([]);
    setError("");
    setLoading(false);
    // 待处理的显式打开历史由下一个 effect 查询，这里不再重复。
    const explicit =
      !!latestRequest.current &&
      handledRequest.current !== latestRequest.current;
    if (!scanPaused)
      void loadFiles().then((name) => {
        if (name && !explicit) setPending(name);
      });
    else {
      setFiles([]);
      setSelected("");
      setPending("");
    }
    return () => {
      fileGeneration.current++;
    };
  }, [loadFiles, scanPaused]);
  useEffect(() => {
    if (!visible || !pending) return;
    setPending("");
    void loadHistory(pending);
  }, [visible, pending, loadHistory]);
  useEffect(() => {
    if (requestId && handledRequest.current !== requestId) {
      handledRequest.current = requestId;
      void loadFiles().then((name) => {
        if (name) return loadHistory(name);
      });
    }
  }, [requestId, loadFiles, loadHistory]);
  useEffect(
    () => () => {
      historyGeneration.current++;
    },
    [],
  );
  useEffect(
    () =>
      bridge.onEvent((event, data) => {
        if (
          event === "repositoryWritten" &&
          (data as { repositoryId?: string } | null)?.repositoryId ===
            repositoryId
        ) {
          void loadFiles();
          void loadHistory();
        }
      }),
    [repositoryId, loadFiles, loadHistory],
  );
  return (
    <div className="cvs-file-history">
      <PanelHeader className="repository-log-toolbar">
        <label htmlFor="cvs-history-file">{t("CVS file")}</label>
        <select
          id="cvs-history-file"
          value={selected}
          onChange={(event) => {
            setSelected(event.target.value);
            void loadHistory(event.target.value);
          }}
        >
          {!files.length && <option value="">{t("No versioned file")}</option>}
          {files.map((file) => (
            <option key={file} value={file}>
              {file}
            </option>
          ))}
        </select>
        <ToolbarButton
          label={t("Refresh File History")}
          icon={
            <CodiconRefresh
              className="codicon codicon-refresh"
              width={16}
              height={16}
              aria-hidden="true"
            />
          }
          action={() => {
            void loadFiles();
            void loadHistory();
          }}
        />
      </PanelHeader>
      {loading && (
        <div role="status" className="repository-empty">
          {t("Loading file revisions…")}
        </div>
      )}
      {error && (
        <div className="repository-error" role="alert">
          {error}
        </div>
      )}
      {!loading && !error && revisions.length === 0 && (
        <div className="repository-empty">
          {t("Choose a versioned file to see its revisions.")}
        </div>
      )}
      <table className="cvs-revision-table">
        <thead>
          <tr>
            <th>{t("Revision")}</th>
            <th>{t("Date")}</th>
            <th>{t("Author")}</th>
            <th>{t("Message")}</th>
          </tr>
        </thead>
        <tbody>
          {revisions.map((revision) => (
            <tr key={revision.revisionId}>
              <td>
                <button
                  type="button"
                  title={t("Compare with previous revision")}
                  onClick={() =>
                    void bridge
                      .request("diffCvsRevision", {
                        repositoryId,
                        filePath: selected,
                        revision: revision.revisionId,
                      })
                      .catch((error) => setError(String(error)))
                  }
                >
                  {revision.revisionId}
                </button>
              </td>
              <td>{revision.timestamp}</td>
              <td>{revision.author.name}</td>
              <td title={revision.body}>{revision.subject}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}
