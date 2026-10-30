import { Allotment } from "allotment";
import { useCallback, useEffect, useState } from "react";
import { t } from "../shared/i18n";
import "allotment/dist/style.css";
import { Tooltip } from "../shared/components/Tooltip";
import "../shared/components/Tooltip.css";
import { bridge } from "../shared/bridge";
import { usePreventSelect } from "../shared/hooks/usePreventSelect";
import { usePanelStore } from "../shared/store/panel-store";
import { useRepositoryStore } from "../shared/store/repository-store";
import { BranchTree } from "./components/BranchTree";
import { CvsHistory } from "./components/CvsHistory";
import { DetailPanel } from "./components/DetailPanel";
import { GitGraphPanel } from "./components/GitGraphPanel";
import { Toolbar } from "./components/Toolbar";

function ProgressBar({ visible }: { visible: boolean }) {
  if (!visible) return null;
  return (
    <div
      style={{
        position: "absolute",
        top: 0,
        left: 0,
        right: 0,
        height: 3,
        zIndex: 10000,
        overflow: "hidden",
        background: "var(--vscode-list-hoverBackground)",
      }}
    >
      <div
        style={{
          height: "100%",
          width: "40%",
          background:
            "linear-gradient(90deg, transparent, var(--vscode-progressBar-background) 30%, var(--vscode-textLink-foreground) 70%, transparent)",
          animation: "progress-slide 1s infinite linear",
        }}
      />
      <style>
        {`@keyframes progress-slide {
          0% { transform: translateX(-100%); }
          100% { transform: translateX(250%); }
        }`}
      </style>
    </div>
  );
}

function GitPanelApp() {
  const loading = usePanelStore((s) => s.loading);
  const commits = usePanelStore((s) => s.commits);
  const operationInProgress = usePanelStore((s) => s.operationInProgress);
  const fetchInitialData = usePanelStore((s) => s.fetchInitialData);

  const [showLeft, setShowLeft] = useState(true);
  const [showRight, setShowRight] = useState(true);
  const [leftWidth, setLeftWidth] = useState(330);

  const toggleLeft = useCallback(() => setShowLeft((v) => !v), []);
  const toggleRight = useCallback(() => setShowRight((v) => !v), []);

  // Drag handle for left panel resize
  const startLeftResize = useCallback(
    (e: React.MouseEvent) => {
      e.preventDefault();
      const startX = e.clientX;
      const startWidth = leftWidth;
      const onMove = (ev: MouseEvent) => {
        const newWidth = Math.max(
          140,
          Math.min(500, startWidth + ev.clientX - startX),
        );
        setLeftWidth(newWidth);
      };
      const onUp = () => {
        document.removeEventListener("mousemove", onMove);
        document.removeEventListener("mouseup", onUp);
      };
      document.addEventListener("mousemove", onMove);
      document.addEventListener("mouseup", onUp);
    },
    [leftWidth],
  );

  const middleRef = usePreventSelect();

  useEffect(() => {
    fetchInitialData();
  }, [fetchInitialData]);

  if (loading && commits.length === 0) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          opacity: 0.5,
        }}
      >
        {t("Loading...")}
      </div>
    );
  }

  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        position: "relative",
      }}
    >
      <ProgressBar visible={operationInProgress || loading} />
      <div style={{ flex: 1, display: "flex", minHeight: 0 }}>
        {/* Left branch panel — outside Allotment to avoid flicker */}
        <div
          style={{
            width: showLeft ? leftWidth : 28,
            height: "100%",
            flexShrink: 0,
            overflow: "hidden",
            display: "flex",
          }}
        >
          {showLeft ? (
            <div
              style={{
                flex: 1,
                height: "100%",
                display: "flex",
                flexDirection: "column",
                overflow: "hidden",
              }}
            >
              <BranchTree onTogglePanel={toggleLeft} />
            </div>
          ) : (
            <div
              style={{
                height: "100%",
                width: "100%",
                display: "flex",
                alignItems: "flex-start",
                justifyContent: "center",
                paddingTop: 4,
              }}
            >
              <Tooltip text={t("Show Branches")}>
                <button
                  type="button"
                  className="panel-toggle-btn"
                  onClick={toggleLeft}
                >
                  <ChevronRightIcon />
                </button>
              </Tooltip>
            </div>
          )}
          {showLeft && (
            <div
              onMouseDown={startLeftResize}
              style={{
                width: 4,
                cursor: "col-resize",
                flexShrink: 0,
                display: "flex",
                alignItems: "center",
                justifyContent: "center",
              }}
            >
              <div
                style={{
                  width: 1,
                  height: "100%",
                  background: "var(--border)",
                }}
              />
            </div>
          )}
          {!showLeft && (
            <div
              style={{
                width: 1,
                flexShrink: 0,
                background: "var(--border)",
              }}
            />
          )}
        </div>

        {/* Middle + Right in Allotment */}
        <div style={{ flex: 1, minWidth: 0 }}>
          <Allotment proportionalLayout={false}>
            <Allotment.Pane minSize={400}>
              <div
                ref={middleRef}
                style={{
                  display: "flex",
                  flexDirection: "column",
                  height: "100%",
                }}
              >
                <Toolbar />
                <GitGraphPanel />
              </div>
            </Allotment.Pane>
            <Allotment.Pane
              preferredSize={350}
              minSize={showRight ? 250 : 28}
              maxSize={showRight ? 600 : 28}
              visible
            >
              {showRight ? (
                <div
                  style={{
                    height: "100%",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
                  <div
                    style={{
                      display: "flex",
                      justifyContent: "flex-end",
                      padding: "4px 4px 0",
                      flexShrink: 0,
                    }}
                  >
                    <Tooltip text={t("Hide Details")}>
                      <button
                        type="button"
                        className="panel-toggle-btn"
                        onClick={toggleRight}
                      >
                        <CloseIcon />
                      </button>
                    </Tooltip>
                  </div>
                  <div style={{ flex: 1, overflow: "hidden" }}>
                    <DetailPanel />
                  </div>
                </div>
              ) : (
                <div
                  style={{
                    height: "100%",
                    display: "flex",
                    alignItems: "flex-start",
                    justifyContent: "center",
                    paddingTop: 4,
                    borderLeft: "1px solid var(--border)",
                  }}
                >
                  <Tooltip text={t("Show Details")}>
                    <button
                      type="button"
                      className="panel-toggle-btn"
                      onClick={toggleRight}
                    >
                      <ChevronLeftIcon />
                    </button>
                  </Tooltip>
                </div>
              )}
            </Allotment.Pane>
          </Allotment>
        </div>
      </div>
    </div>
  );
}

function ChevronRightIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M6 4.5L9.5 8L6 11.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function ChevronLeftIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M10 4.5L6.5 8L10 11.5"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d="M4.5 11.5L11.5 4.5M11.5 11.5L4.5 4.5"
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  );
}

export function PanelApp() {
  const { repositories, logRepositoryId, activeFile, ready, load, select } =
    useRepositoryStore();
  const repository = repositories.find((item) => item.id === logRepositoryId);
  useEffect(() => {
    void load();
  }, [load]);
  useEffect(() => {
    usePanelStore.setState({
      repositoryId: logRepositoryId,
      commits: [],
      visibleCommits: [],
      branches: [],
      tags: [],
      commitFiles: [],
      selectedCommitHash: null,
      selectedCommitHashes: [],
      selectedFilePath: null,
      rangeOldest: null,
      rangeNewest: null,
      laneSnapshot: null,
      graphLayout: {},
      filter: {
        searchQuery: "",
        branch: "",
        author: "",
        dateRange: "",
        file: "",
      },
      loading: false,
      hasMore: true,
    });
  }, [logRepositoryId]);
  return (
    <div
      style={{
        height: "100%",
        display: "flex",
        flexDirection: "column",
        minHeight: 0,
      }}
    >
      <div className="repository-log-toolbar">
        <label htmlFor="log-repository">{t("Repository")}</label>
        <select
          id="log-repository"
          value={logRepositoryId ?? ""}
          onChange={(event) => void select(event.target.value, "log")}
        >
          {!repository && <option value="">{t("Select repository")}</option>}
          {repositories.map((item) => (
            <option key={item.id} value={item.id}>
              {item.name} [{item.kind.toUpperCase()}] — {item.root}
            </option>
          ))}
        </select>
        <button
          type="button"
          onClick={() => void bridge.request("refreshRepositories")}
        >
          {t("Refresh")}
        </button>
      </div>
      <div style={{ flex: 1, minHeight: 0 }}>
        {!ready ? (
          <div className="repository-empty">{t("Loading repositories…")}</div>
        ) : !repository ? (
          <div className="repository-empty">
            {t("No available repository.")}
          </div>
        ) : repository.kind === "cvs" ? (
          <CvsHistory
            key={repository.id}
            repositoryId={repository.id}
            activeFile={activeFile}
          />
        ) : (
          <GitPanelApp key={repository.id} />
        )}
      </div>
    </div>
  );
}
