import { useEffect, useRef } from "react";
import {
  createVcsTranslator,
  VcsHistoryLayout,
  type VcsHistoryLayoutHandle,
} from "../../../packages/vcs-ui/src";
import { CommitApp } from "../commit/App";
import { usePreventSelect } from "../shared/hooks/usePreventSelect";
import { t } from "../shared/i18n";
import { useCommitStore } from "../shared/store/commit-store";
import { usePanelStore } from "../shared/store/panel-store";
import { useWorkbenchStore } from "../shared/store/workbench-store";
import { ComparisonPreview } from "../shared/workbench/ComparisonPreview";
import { RepositoryCatalog } from "../shared/workbench/RepositoryCatalog";
import { BranchTree } from "./components/BranchTree";
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
        background: "rgba(0, 122, 204, 0.15)",
      }}
    >
      <div
        style={{
          height: "100%",
          width: "40%",
          background:
            "linear-gradient(90deg, transparent, #007acc 30%, #3794ff 70%, transparent)",
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

export function PanelApp() {
  const loading = usePanelStore((state) => state.loading);
  const commits = usePanelStore((state) => state.commits);
  const operationInProgress = usePanelStore(
    (state) => state.operationInProgress,
  );
  const fetchInitialData = usePanelStore((state) => state.fetchInitialData);
  const middleRef = usePreventSelect();
  const layoutRef = useRef<VcsHistoryLayoutHandle>(null);
  const { layout, setLayout, diff, setDiff, commitRevealRequest } =
    useWorkbenchStore();
  const uiText = createVcsTranslator(
    document.getElementById("root")?.dataset.language,
  );
  useEffect(() => {
    if (commitRevealRequest) {
      useCommitStore.getState().setActiveTab("commit");
      layoutRef.current?.revealCommit();
    }
  }, [commitRevealRequest]);
  useEffect(() => {
    void fetchInitialData();
  }, [fetchInitialData]);

  return (
    <div style={{ height: "100%", position: "relative" }}>
      <ProgressBar visible={operationInProgress || loading} />
      <VcsHistoryLayout
        commit={<CommitApp />}
        repositoryList={<RepositoryCatalog />}
        diff={<ComparisonPreview state={diff} onChange={setDiff} />}
        layout={layout}
        onLayoutChange={setLayout}
        layoutRef={layoutRef}
        sidebar={(toggle) => <BranchTree onTogglePanel={toggle} />}
        toolbar={<Toolbar />}
        revisionList={
          loading && commits.length === 0 ? (
            <div className="vcs-ui-history-empty">{t("panel.loading")}</div>
          ) : (
            <GitGraphPanel />
          )
        }
        detail={<DetailPanel />}
        middleRef={middleRef}
        labels={{
          showCommit: uiText("layout.showCommit"),
          hideCommit: uiText("layout.hideCommit"),
          resizeCommit: uiText("layout.resizeCommit"),
          resizeSidebar: uiText("layout.resizeNavigation"),
          resizeDetail: uiText("layout.resizeDetail"),
          showSidebar: t("catalog.search"),
          maximizeDiff: t("diff.maximize"),
          restoreDiff: t("diff.restore"),
          resizeDiff: t("diff.resize"),
          showDetail: t("panel.showDetails"),
          hideDetail: t("panel.hideDetails"),
        }}
      />
    </div>
  );
}
