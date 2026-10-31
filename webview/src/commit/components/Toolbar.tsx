import { bridge } from "../../shared/bridge";
import { VerticalToolbar } from "../../shared/components/VerticalToolbar";
import { t } from "../../shared/i18n";
import { useCommitStore } from "../../shared/store/commit-store";
import { changeAction } from "./ChangeTree";

export function Icon({ path }: { path: string }) {
  return (
    <svg
      viewBox="0 0 16 16"
      width="16"
      height="16"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.3"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={path} />
    </svg>
  );
}
interface ToolbarProps {
  onRefresh: () => void;
  onShelve: () => void;
  onRollback: () => void;
  hasChanges: boolean;
  gitSelected: boolean;
  hasGit: boolean;
  onTogglePreview: () => void;
  previewVisible: boolean;
}
export function Toolbar(props: ToolbarProps) {
  const state = useCommitStore();
  const button = (
    label: string,
    path: string,
    action: () => void,
    disabled = false,
    active = false,
  ) => (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      className={active ? "active" : ""}
      aria-pressed={active}
      onClick={action}
    >
      <Icon path={path} />
    </button>
  );
  return (
    <VerticalToolbar
      className="changes-toolbar"
      role="toolbar"
      aria-label={t("Local Changes")}
    >
      {button(
        t("Refresh"),
        "M13 8a5 5 0 1 1-1.5-3.5M13 2.5V5h-2.5",
        props.onRefresh,
      )}
      {button(
        t("Commit..."),
        "M3 8.5l3 3 7-7",
        state.enterCommitMode,
        !props.hasChanges,
        state.commitMode,
      )}
      {button(
        t("Rollback"),
        "M5 4L2 7l3 3M2 7h7a4 4 0 0 1 0 7H7",
        props.onRollback,
        !props.hasChanges,
      )}
      {button(
        t("Update Project"),
        "M8 2v9M4.5 7.5L8 11l3.5-3.5M3 14h10",
        () => void changeAction(() => bridge.request("updateProject", {})),
      )}
      {props.hasGit &&
        button(
          t("Shelve Changes (Git only)"),
          "M2.5 6h11v7.5h-11zM4 3h8l1.5 3M6 9h4",
          props.onShelve,
          !props.gitSelected || !props.hasChanges,
        )}
      <hr />
      {button(
        t("Diff Preview"),
        "M1.5 8S4 3.5 8 3.5 14.5 8 14.5 8 12 12.5 8 12.5 1.5 8 1.5 8zM10 8a2 2 0 1 1-4 0 2 2 0 0 1 4 0",
        props.onTogglePreview,
        false,
        props.previewVisible,
      )}
      {button(
        t("Group By Directory"),
        "M2.5 3.5h4M4.5 7.5h4M4.5 11.5h4M2.5 3.5v8h2",
        state.toggleGroupByDirectory,
        false,
        state.groupByDirectory,
      )}
      {button(t("Expand All"), "M5 6l3-3 3 3M5 10l3 3 3-3", () => {
        state.expandAllDirs();
        useCommitStore.setState({
          expandedGroups: new Set([
            "changes",
            "unversioned",
            "incoming",
            "ignored",
          ]),
        });
      })}
      {button(t("Collapse All"), "M5 3l3 3 3-3M5 13l3-3 3 3", () => {
        useCommitStore.setState({ expandedGroups: new Set() });
      })}
    </VerticalToolbar>
  );
}
