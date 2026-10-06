import { StrictMode } from "react";
import { createRoot } from "react-dom/client";
import { ConflictsApp } from "./conflicts/App";
import { MergeStandaloneApp } from "./conflicts/MergeStandaloneApp";
import { CvsApp } from "./cvs/App";
import { PanelApp } from "./panel/App";
import { PushApp } from "./push/App";
import { RollbackApp } from "./rollback/App";
import { bridge } from "./shared/bridge";
import { initializeI18n } from "./shared/i18n";
import "./shared/theme/variables.css";

// Fix Cmd+A/Ctrl+A not working in webview inputs (VS Code intercepts it)
document.addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "a") {
    const target = e.target as HTMLElement;
    if (target.tagName === "INPUT" || target.tagName === "TEXTAREA") {
      e.stopPropagation();
      (target as HTMLInputElement).select();
    }
  }
});

const root = document.getElementById("root");
if (!root) throw new Error("Root element not found");
initializeI18n(root.dataset.language);
const mode = root.dataset.mode as
  | "panel"
  | "merge"
  | "conflicts"
  | "cvs"
  | "push"
  | "rollback"
  | undefined;

createRoot(root).render(
  <StrictMode>
    {mode === "merge" ? (
      <MergeStandaloneApp />
    ) : mode === "conflicts" ? (
      <ConflictsApp />
    ) : mode === "cvs" ? (
      <CvsApp />
    ) : mode === "push" ? (
      <PushApp />
    ) : mode === "rollback" ? (
      <RollbackApp />
    ) : (
      <PanelApp />
    )}
  </StrictMode>,
);

// Store event listeners exist before the Host releases a pending file-history request.
if (mode === "panel") bridge.notifyHistoryReady?.();
