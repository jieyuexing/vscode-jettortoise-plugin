import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../../shared/bridge";
import { t } from "../../shared/i18n";

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
}: {
  repositoryId: string;
  activeFile?: string;
}) {
  const [files, setFiles] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [revisions, setRevisions] = useState<Revision[]>([]);
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const fileGeneration = useRef(0);
  const historyGeneration = useRef(0);
  const loadFiles = useCallback(async () => {
    const generation = ++fileGeneration.current;
    try {
      const names = (await bridge.request("getCvsFiles", {
        repositoryId,
      })) as string[];
      if (generation !== fileGeneration.current) return;
      setFiles(names);
      setSelected((value) =>
        activeFile && names.includes(activeFile)
          ? activeFile
          : names.includes(value)
            ? value
            : (names[0] ?? ""),
      );
    } catch (error) {
      if (generation === fileGeneration.current) setError(String(error));
    }
  }, [repositoryId, activeFile]);
  const loadHistory = useCallback(async () => {
    const generation = ++historyGeneration.current;
    if (!selected) return;
    setLoading(true);
    setError("");
    setRevisions([]);
    try {
      const result = (await bridge.request("getCvsHistory", {
        repositoryId,
        filePath: selected,
      })) as Revision[];
      if (generation === historyGeneration.current) setRevisions(result);
    } catch (error) {
      if (generation === historyGeneration.current) setError(String(error));
    } finally {
      if (generation === historyGeneration.current) setLoading(false);
    }
  }, [repositoryId, selected]);
  useEffect(() => {
    void loadFiles();
    return () => {
      fileGeneration.current++;
    };
  }, [loadFiles]);
  useEffect(() => {
    void loadHistory();
    return () => {
      historyGeneration.current++;
    };
  }, [loadHistory]);
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
      <div className="repository-log-toolbar">
        <label htmlFor="cvs-history-file">{t("CVS file")}</label>
        <select
          id="cvs-history-file"
          value={selected}
          onChange={(event) => setSelected(event.target.value)}
        >
          {!files.length && <option value="">{t("No versioned file")}</option>}
          {files.map((file) => (
            <option key={file} value={file}>
              {file}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => {
            void loadFiles();
            void loadHistory();
          }}
        >
          {t("Refresh File History")}
        </button>
      </div>
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
