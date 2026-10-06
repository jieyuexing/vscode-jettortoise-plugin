import {
  type MouseEvent as ReactMouseEvent,
  type ReactNode,
  type Ref,
  useEffect,
  useImperativeHandle,
  useRef,
  useState,
} from "react";
import {
  getVcsPaneVisibility,
  readVcsLayoutState,
  VCS_PANE_LIMITS,
  type VcsAuxiliaryPane,
  type VcsLayoutState,
} from "./layout-state";
import { Tooltip } from "./Tooltip";

export interface VcsHistoryLabels {
  showCommit: string;
  hideCommit: string;
  showSidebar: string;
  showDetail: string;
  hideDetail: string;
  resizeCommit: string;
  resizeSidebar: string;
  resizeDetail: string;
  showDiff?: string;
  hideDiff?: string;
  maximizeDiff?: string;
  restoreDiff?: string;
  resizeDiff?: string;
}
export interface VcsHistoryLayoutHandle {
  revealCommit(): void;
}
export interface VcsHistoryLayoutProps {
  commit: ReactNode;
  /** A catalog supplied by the host. It is intentionally presentation-only. */
  repositoryList?: ReactNode;
  sidebar: (toggleSidebar: () => void) => ReactNode;
  toolbar: ReactNode;
  revisionList: ReactNode;
  detail: ReactNode;
  /** Read-only preview supplied by the concrete VCS panel. */
  diff?: ReactNode;
  labels: VcsHistoryLabels;
  middleRef?: Ref<HTMLDivElement>;
  commitRef?: Ref<HTMLDivElement>;
  layoutRef?: Ref<VcsHistoryLayoutHandle>;
  layout: VcsLayoutState;
  onLayoutChange: (state: VcsLayoutState) => void;
}

/** One mounted workspace: commit editing stays independent from history browsing. */
export function VcsHistoryLayout({
  commit,
  repositoryList,
  sidebar,
  toolbar,
  revisionList,
  detail,
  diff,
  labels,
  middleRef,
  commitRef,
  layoutRef,
  layout: inputLayout,
  onLayoutChange,
}: VcsHistoryLayoutProps) {
  const root = useRef<HTMLDivElement>(null);
  const layout = readVcsLayoutState(inputLayout);
  const current = useRef(layout);
  current.current = layout;
  const [availableWidth, setAvailableWidth] = useState(0);
  const [focusedPane, setFocusedPane] = useState<VcsAuxiliaryPane | null>(null);
  const [forcedOpen, setForcedOpen] = useState<VcsAuxiliaryPane | null>(null);
  const [focusRequest, setFocusRequest] = useState<{
    pane: VcsAuxiliaryPane;
    input: boolean;
  } | null>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  const protectedPanes = [focusedPane, forcedOpen].filter(
    (pane): pane is VcsAuxiliaryPane => pane !== null,
  );
  const visible = getVcsPaneVisibility(layout, availableWidth, protectedPanes);

  useEffect(() => {
    const element = root.current;
    if (!element) return;
    const update = () => setAvailableWidth(element.clientWidth);
    update();
    if (typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(update);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    setForcedOpen(null);
  }, [availableWidth]);
  useEffect(() => () => dragCleanup.current?.(), []);

  const change = (next: VcsLayoutState) => {
    current.current = readVcsLayoutState(next);
    onLayoutChange(current.current);
  };
  const toggle = (pane: VcsAuxiliaryPane) => {
    const expanding = !visible[pane];
    change({
      ...current.current,
      collapsed: { ...current.current.collapsed, [pane]: !expanding },
    });
    setForcedOpen(expanding ? pane : null);
    setFocusRequest({ pane, input: expanding });
  };
  useImperativeHandle(layoutRef, () => ({
    revealCommit() {
      change({
        ...current.current,
        diffMaximized: false,
        collapsed: { ...current.current.collapsed, commit: false },
      });
      setForcedOpen("commit");
      setFocusRequest({ pane: "commit", input: true });
    },
  }));
  useEffect(() => {
    if (!focusRequest) return;
    const element = root.current?.querySelector<HTMLElement>(
      `[data-vcs-pane="${focusRequest.pane}"]`,
    );
    const target = focusRequest.input
      ? element?.querySelector<HTMLElement>(
          "[data-vcs-pane-content] textarea, [data-vcs-pane-content] input, [data-vcs-pane-content] button, [data-vcs-pane-content]",
        )
      : element?.querySelector<HTMLElement>("[data-vcs-restore]");
    // Prefer the editor when present; selector lists otherwise use document order.
    const editor = focusRequest.input
      ? element?.querySelector<HTMLElement>("textarea")
      : null;
    (editor ?? target)?.focus({ preventScroll: true });
    setFocusRequest(null);
  }, [focusRequest]);

  const resize = (pane: VcsAuxiliaryPane, width: number) =>
    change({
      ...current.current,
      widths: { ...current.current.widths, [pane]: width },
    });
  const startResize = (event: ReactMouseEvent, pane: VcsAuxiliaryPane) => {
    if (event.button !== 0) return;
    event.preventDefault();
    dragCleanup.current?.();
    const startX = event.clientX;
    const startWidth = current.current.widths[pane];
    const move = (next: MouseEvent) =>
      resize(
        pane,
        startWidth + (next.clientX - startX) * (pane === "detail" ? -1 : 1),
      );
    const end = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", end);
      dragCleanup.current = null;
    };
    dragCleanup.current = end;
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", end);
  };
  const startDiffResize = (event: ReactMouseEvent) => {
    if (event.button !== 0 || layout.diffMaximized) return;
    event.preventDefault();
    dragCleanup.current?.();
    const startY = event.clientY;
    const startHeight = layout.diffHeight ?? 55;
    const move = (next: MouseEvent) => {
      const containerHeight = root.current?.clientHeight || 1;
      const delta = ((next.clientY - startY) / containerHeight) * 100;
      change({ ...current.current, diffHeight: Math.round(Math.max(25, Math.min(75, startHeight + delta))) });
    };
    const end = () => {
      document.removeEventListener("mousemove", move);
      document.removeEventListener("mouseup", end);
      dragCleanup.current = null;
    };
    dragCleanup.current = end;
    document.addEventListener("mousemove", move);
    document.addEventListener("mouseup", end);
  };
  const divider = (pane: VcsAuxiliaryPane, label: string) => (
    <div
      role="separator"
      tabIndex={0}
      aria-orientation="vertical"
      aria-label={label}
      aria-valuemin={VCS_PANE_LIMITS[pane].min}
      aria-valuemax={VCS_PANE_LIMITS[pane].max}
      aria-valuenow={layout.widths[pane]}
      className={`vcs-ui-workspace-divider ${pane === "detail" ? "at-start" : ""}`}
      onMouseDown={(event) => startResize(event, pane)}
      onKeyDown={(event) => {
        if (event.key === "Enter") {
          event.preventDefault();
          toggle(pane);
          return;
        }
        if (!["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key))
          return;
        event.preventDefault();
        const direction =
          (event.key === "ArrowRight" ? 1 : -1) * (pane === "detail" ? -1 : 1);
        resize(
          pane,
          event.key === "Home"
            ? VCS_PANE_LIMITS[pane].min
            : event.key === "End"
              ? VCS_PANE_LIMITS[pane].max
              : current.current.widths[pane] + direction * 10,
        );
      }}
    />
  );
  const pane = (
    name: VcsAuxiliaryPane,
    content: ReactNode,
    showLabel: string,
    resizeLabel: string,
    hideLabel?: string,
  ) => (
    <div
      data-vcs-pane={name}
      inert={Boolean(diff && layout.diffMaximized)}
      className={`vcs-ui-workspace-pane vcs-ui-workspace-${name}`}
      style={{ width: visible[name] ? layout.widths[name] : 28 }}
    >
      <div
        data-vcs-pane-content
        tabIndex={-1}
        className="vcs-ui-workspace-pane-content"
        style={{ display: visible[name] ? "flex" : "none" }}
        ref={name === "commit" ? commitRef : undefined}
      >
        {hideLabel && (
          <div className="vcs-ui-workspace-hide">
            <Tooltip text={hideLabel}>
              <button
                type="button"
                className="panel-toggle-btn"
                aria-label={hideLabel}
                onClick={() => toggle(name)}
              >
                <CloseIcon />
              </button>
            </Tooltip>
          </div>
        )}
        {content}
      </div>
      {!visible[name] && (
        <div className="vcs-ui-history-collapsed-control">
          <Tooltip text={showLabel}>
            <button
              type="button"
              data-vcs-restore
              className="panel-toggle-btn"
              aria-label={showLabel}
              onClick={() => toggle(name)}
            >
              <ChevronIcon left={name === "detail"} />
            </button>
          </Tooltip>
        </div>
      )}
      {visible[name] && divider(name, resizeLabel)}
    </div>
  );
  const navigation = pane(
    "navigation",
    <>
      {repositoryList && <div className="vcs-ui-workspace-repositories">{repositoryList}</div>}
      {sidebar(() => toggle("navigation"))}
    </>,
    labels.showSidebar,
    labels.resizeSidebar,
  );
  const historyAndDetail = (
    <div className="vcs-ui-workspace-history-row">
      <div
        data-vcs-pane="history"
        ref={middleRef}
        className="vcs-ui-history-middle vcs-ui-workspace-history"
      >
        {toolbar}
        {revisionList}
      </div>
      {pane("detail", detail, labels.showDetail, labels.resizeDetail, labels.hideDetail)}
    </div>
  );
  const workArea = diff ? (
    <div className={`vcs-ui-workspace-right ${layout.diffMaximized ? "diff-maximized" : ""}`}>
      <div
        data-vcs-pane="diff"
        className="vcs-ui-workspace-diff"
        style={{ height: layout.diffMaximized ? "100%" : `${layout.diffHeight ?? 55}%` }}
      >
        <div className="vcs-ui-workspace-diff-actions">
          <Tooltip text={layout.diffMaximized ? (labels.restoreDiff ?? "Restore history") : (labels.maximizeDiff ?? "Maximize diff")}>
            <button
              type="button"
              className="panel-toggle-btn"
              aria-label={layout.diffMaximized ? (labels.restoreDiff ?? "Restore history") : (labels.maximizeDiff ?? "Maximize diff")}
              onClick={() => change({ ...current.current, diffMaximized: !current.current.diffMaximized })}
            >
              {layout.diffMaximized ? <RestoreIcon /> : <MaximizeIcon />}
            </button>
          </Tooltip>
        </div>
        {diff}
      </div>
      {!layout.diffMaximized && (
        <div
          className="vcs-ui-workspace-horizontal-divider"
          role="separator"
          tabIndex={0}
          aria-orientation="horizontal"
          aria-label={labels.resizeDiff ?? "Resize diff"}
          onMouseDown={startDiffResize}
          onKeyDown={(event) => {
            if (!['ArrowUp', 'ArrowDown', 'Home', 'End'].includes(event.key)) return;
            event.preventDefault();
            const currentHeight = current.current.diffHeight ?? 55;
            change({ ...current.current, diffHeight: event.key === 'Home' ? 25 : event.key === 'End' ? 75 : currentHeight + (event.key === 'ArrowDown' ? 5 : -5) });
          }}
        />
      )}
      <div className={`vcs-ui-workspace-history-host${layout.diffMaximized ? " vcs-ui-workspace-history-suspended" : ""}`}>{historyAndDetail}</div>
    </div>
  ) : historyAndDetail;
  return (
    <div
      ref={root}
      className={`vcs-ui-history-layout vcs-ui-workspace${layout.diffMaximized ? " vcs-ui-workspace-diff-fullscreen" : ""}`}
      onFocusCapture={(event) => {
        const name = (event.target as HTMLElement).closest<HTMLElement>(
          "[data-vcs-pane]",
        )?.dataset.vcsPane;
        setFocusedPane(
          name === "commit" || name === "navigation" || name === "detail"
            ? name
            : null,
        );
      }}
      onBlurCapture={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null))
          setFocusedPane(null);
      }}
    >
      <div className="vcs-ui-workspace-row">
        {repositoryList && navigation}
        {pane(
          "commit",
          commit,
          labels.showCommit,
          labels.resizeCommit,
          labels.hideCommit,
        )}
        {!repositoryList && navigation}
        {workArea}
      </div>
    </div>
  );
}

export interface VcsCommitLayoutProps {
  toolbar: ReactNode;
  content: ReactNode;
  className?: string;
}
export function VcsCommitLayout({
  toolbar,
  content,
  className = "commit-app",
}: VcsCommitLayoutProps) {
  return (
    <div className={className}>
      {toolbar}
      <div className="commit-content">{content}</div>
    </div>
  );
}
function ChevronIcon({ left }: { left: boolean }) {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        d={left ? "m10 4.5-3.5 3.5 3.5 3.5" : "m6 4.5 3.5 3.5-3.5 3.5"}
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
        d="m4.5 11.5 7-7m0 7-7-7"
        stroke="currentColor"
        strokeLinecap="round"
      />
    </svg>
  );
}
function MaximizeIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M3.5 6V3.5H6M10 3.5h2.5V6m0 4v2.5H10M6 12.5H3.5V10" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
function RestoreIcon() {
  return <svg width="16" height="16" viewBox="0 0 16 16" fill="none"><path d="M6 3.5H3.5V6m6.5-2.5h2.5V6M3.5 10v2.5H6m6.5-2.5v2.5H10" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" /></svg>;
}
