// biome-ignore-all lint/correctness/useExhaustiveDependencies: Host listener intentionally mounts once; state persistence is explicit below.

import { useEffect, useRef, useState } from "react";
import {
  createVcsTranslator,
  readVcsLayoutState,
  type VcsCapabilities,
  VcsFileTree,
  VcsHistoryLayout,
  type VcsHistoryLayoutHandle,
  type VcsLayoutState,
  VcsRepositoryBoundaries,
  type VcsRepositoryBoundary,
} from "../../../packages/vcs-ui/src";
import { getVSCodeApi } from "../shared/bridge/vscode-api";
import { t as uiT } from "../shared/i18n";
import { ComparisonPreview } from "../shared/workbench/ComparisonPreview";
import { RepositoryCatalog } from "../shared/workbench/RepositoryCatalog";
import {
  type DiffState,
  readDiffState,
  selectComparison,
} from "../shared/workbench/transport";
import { cvsEn, cvsT } from "./i18n";
import "./cvs.css";

type CvsFile = { newPath: string; state: string; entryRevision: string };
type Revision = {
  revisionId: string;
  timestamp: string;
  subject: string;
  body?: string;
  branchId: string;
  branchNames: string[];
  defaultBranch: string;
  author: { name: string };
};
type Saved = {
  version: 1;
  repository?: { kind: "cvs"; root: string };
  history: {
    selected: string;
    selectedRevision: string;
    collapsed: Record<string, boolean>;
  };
  commit: { checked: string[]; message: string };
  layout: VcsLayoutState;
  diff?: DiffState;
};
const fallback = (): Saved => ({
  version: 1,
  history: { selected: "", selectedRevision: "", collapsed: {} },
  commit: { checked: [], message: "" },
  layout: readVcsLayoutState(undefined),
});
const committable = (file: CvsFile) =>
  ["Locally Modified", "Locally Added", "Locally Removed"].includes(file.state);
/** CVS four-column consumer. It receives its fixed repository identity from Host init. */
export function CvsApp() {
  const api = getVSCodeApi();
  const [saved] = useState<Saved>(() => {
    const value = api.getState() as Partial<Saved> | undefined;
    return value?.version === 1 && value.history && value.commit && value.layout
      ? (value as Saved)
      : fallback();
  });
  const language = document
    .getElementById("root")
    ?.dataset.language?.toLowerCase();
  const [diff, setDiff] = useState(readDiffState(saved.diff));
  const [layout, setLayout] = useState(saved.layout),
    [files, setFiles] = useState<CvsFile[]>([]),
    [selected, setSelected] = useState(saved.history.selected),
    [collapsed, setCollapsed] = useState(saved.history.collapsed),
    [checked, setChecked] = useState(saved.commit.checked),
    [message, setMessage] = useState(saved.commit.message),
    [revisions, setRevisions] = useState<Revision[]>([]),
    [revision, setRevision] = useState<Revision | undefined>(),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [zh, setZh] = useState(
      language === "zh" || language === "zh-cn" || language === "zh-tw",
    ),
    [caps, setCaps] = useState<VcsCapabilities>({}),
    [repository, setRepository] = useState<
      { kind: "cvs"; root: string } | undefined
    >(() => {
      try {
        const value = JSON.parse(
          document.getElementById("root")?.dataset.repository ?? "null",
        );
        return value?.kind === "cvs" && typeof value.root === "string"
          ? { kind: "cvs", root: value.root }
          : undefined;
      } catch {
        return undefined;
      }
    });
  const [boundaries, setBoundaries] = useState<VcsRepositoryBoundary[]>([]);
  const boundaryText = createVcsTranslator(zh ? "zh-cn" : "en");
  const layoutRef = useRef<VcsHistoryLayoutHandle>(null);
  const currentSelection = useRef(selected);
  currentSelection.current = selected;
  const t = Object.fromEntries(
    Object.keys(cvsEn).map((key) => [
      key,
      cvsT(zh ? "zh-cn" : "en", key as keyof typeof cvsEn),
    ]),
  ) as Record<keyof typeof cvsEn, string>;
  const send = (type: string, data: Record<string, unknown> = {}) =>
    api.postMessage({ type, ...data });
  useEffect(() => {
    const listener = (event: MessageEvent) => {
      const data = event.data as Record<string, unknown>;
      switch (data.type) {
        case "init": {
          const nextLanguage = String(data.language).toLowerCase();
          setZh(
            nextLanguage === "zh" ||
              nextLanguage === "zh-cn" ||
              nextLanguage === "zh-tw",
          );
          setCaps((data.capabilities ?? {}) as VcsCapabilities);
          setRepository(data.repository as { kind: "cvs"; root: string });
          break;
        }
        case "state": {
          const next = (data.files ?? []) as CvsFile[];
          setFiles(next);
          setBoundaries((data.boundaries ?? []) as VcsRepositoryBoundary[]);
          setChecked((value) =>
            value.filter((name) =>
              next.some((file) => file.newPath === name && committable(file)),
            ),
          );
          break;
        }
        case "history":
          if (data.path === currentSelection.current) {
            const next = (data.revisions ?? []) as Revision[];
            setRevisions(next);
            setRevision(
              next.find(
                (item) => item.revisionId === saved.history.selectedRevision,
              ) ?? next[0],
            );
          }
          break;
        case "busy":
          setBusy(Boolean(data.busy));
          if (data.busy) setError("");
          break;
        case "error":
          setError(String(data.message ?? ""));
          break;
        case "showFileHistory":
          select(String(data.file ?? ""));
          break;
        case "focusCommit":
          layoutRef.current?.revealCommit();
          break;
        case "committed":
          setMessage("");
          setChecked([]);
          break;
      }
    };
    window.addEventListener("message", listener);
    send("ready");
    return () => window.removeEventListener("message", listener);
  }, []);
  useEffect(() => {
    api.setState({
      version: 1,
      repository,
      history: {
        selected,
        selectedRevision: revision?.revisionId ?? "",
        collapsed,
      },
      commit: { checked, message },
      layout,
      diff,
    });
  }, [
    repository,
    selected,
    revision,
    collapsed,
    checked,
    message,
    layout,
    diff,
  ]);
  useEffect(() => {
    if (selected && files.some((file) => file.newPath === selected))
      send("history", { path: selected });
  }, [files]);
  const select = (value: string) => {
    setSelected(value);
    setRevisions([]);
    setRevision(undefined);
    if (value) send("history", { path: value });
  };
  const commit = (
    <div className="cvs-commit">
      <h2>{t.commit}</h2>
      <div className="cvs-commit-actions">
        <button
          disabled={busy}
          onClick={() =>
            setChecked(files.filter(committable).map((file) => file.newPath))
          }
        >
          {t.all}
        </button>
        <button disabled={busy} onClick={() => setChecked([])}>
          {t.clear}
        </button>
      </div>
      <div className="cvs-changes">
        {!files.some(committable) && <p>{t.noChanges}</p>}
        {files
          .filter((file) => file.state !== "Up-to-date")
          .map((file) => (
            <label key={file.newPath}>
              <input
                type="checkbox"
                checked={checked.includes(file.newPath)}
                disabled={busy || !committable(file)}
                onChange={(event) =>
                  setChecked(
                    event.target.checked
                      ? [...checked, file.newPath]
                      : checked.filter((path) => path !== file.newPath),
                  )
                }
              />
              <button
                type="button"
                onClick={() =>
                  selectComparison({
                    source: "working",
                    filePath: file.newPath,
                  })
                }
              >
                {file.newPath}
              </button>
              <small>
                {cvsT(
                  zh ? "zh-cn" : "en",
                  `status.${file.state}` as keyof typeof cvsEn,
                )}
              </small>
              {/^\d+\./.test(file.entryRevision) && (
                <button
                  disabled={busy}
                  onClick={() => send("rollback", { path: file.newPath })}
                >
                  {t.rollback}
                </button>
              )}
            </label>
          ))}
      </div>
      <VcsRepositoryBoundaries
        items={boundaries}
        title={boundaryText("repository.nested")}
        openLabel={boundaryText("repository.open")}
        addLabel={boundaryText("repository.add")}
        onOpen={(boundaryId) => send("openRepositoryBoundary", { boundaryId })}
      />
      <label>
        {t.message}
        <textarea
          value={message}
          disabled={busy}
          maxLength={16000}
          onChange={(event) => setMessage(event.target.value)}
          onKeyDown={(event) => {
            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
              event.stopPropagation();
              if (!busy && caps.commit && checked.length && message.trim())
                send("commit", { paths: checked, message });
            }
          }}
        />
      </label>
      <button
        disabled={busy || !checked.length || !message.trim() || !caps.commit}
        onClick={() => send("commit", { paths: checked, message })}
      >
        {t.commit} ({checked.length})
      </button>
    </div>
  );
  return (
    <div className="cvs-app">
      <div className="cvs-toolbar">
        <strong>{t.product}</strong>
        <button disabled={busy} onClick={() => send("refresh")}>
          {t.refresh}
        </button>
        {caps.update && (
          <button disabled={busy} onClick={() => send("update")}>
            {t.update}
          </button>
        )}
        {busy && <button onClick={() => send("cancel")}>{t.cancel}</button>}
      </div>
      {error && (
        <p role="alert" className="cvs-error">
          {error}
        </p>
      )}
      <VcsHistoryLayout
        layout={layout}
        onLayoutChange={setLayout}
        layoutRef={layoutRef}
        labels={{
          ...t,
          showSidebar: uiT("catalog.search"),
          maximizeDiff: uiT("diff.maximize"),
          restoreDiff: uiT("diff.restore"),
          resizeDiff: uiT("diff.resize"),
        }}
        repositoryList={<RepositoryCatalog />}
        diff={<ComparisonPreview state={diff} onChange={setDiff} />}
        commit={commit}
        sidebar={(toggle) => (
          <div className="cvs-navigation">
            <div>
              <h2>{t.files}</h2>
              <button onClick={toggle}>{t.showSidebar}</button>
            </div>
            <select
              value={selected}
              onChange={(event) => select(event.target.value)}
            >
              <option value="">{t.select}</option>
              {files.map((file) => (
                <option key={file.newPath} value={file.newPath}>
                  {file.newPath}
                </option>
              ))}
            </select>
            <VcsFileTree
              files={files}
              viewMode="tree"
              selectedFiles={[selected]}
              onFileClick={(_event, file) => select(file.newPath)}
              collapsed={collapsed}
              onToggle={(key) =>
                setCollapsed((value) => ({ ...value, [key]: !value[key] }))
              }
              formatFileCount={(value) => String(value)}
            />
          </div>
        )}
        toolbar={
          <div className="cvs-history-header">
            <h2>{t.history}</h2>
            <p>{selected || t.select}</p>
            {selected && (
              <button
                disabled={busy}
                onClick={() => send("diff", { path: selected })}
              >
                {t.diff}
              </button>
            )}
          </div>
        }
        revisionList={
          <div className="cvs-revisions">
            {!revisions.length && <p>{t.noHistory}</p>}
            {revisions.map((item) => (
              <button
                key={item.revisionId}
                className={
                  item.revisionId === revision?.revisionId ? "active" : ""
                }
                onClick={() => {
                  setRevision(item);
                  if (selected)
                    selectComparison({
                      source: "history",
                      filePath: selected,
                      revision: item.revisionId,
                    });
                }}
              >
                <code>{item.revisionId}</code>
                <span>
                  {item.subject}
                  <small>
                    {item.author.name} · {item.timestamp}
                  </small>
                </span>
              </button>
            ))}
          </div>
        }
        detail={
          <div className="cvs-detail">
            {revision ? (
              <>
                <h2>{t.details}</h2>
                <code>{revision.revisionId}</code>
                <p>{revision.subject}</p>
                <pre>{revision.body}</pre>
                <button
                  disabled={busy || !caps.compareRevision}
                  onClick={() =>
                    send("compare", {
                      path: selected,
                      revision: revision.revisionId,
                    })
                  }
                >
                  {t.compare}
                </button>
              </>
            ) : (
              <p>{t.select}</p>
            )}
          </div>
        }
      />
    </div>
  );
}
