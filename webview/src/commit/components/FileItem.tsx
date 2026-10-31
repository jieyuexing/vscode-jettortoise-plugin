import { t } from "../../shared/i18n";
import { canCommit } from "../../shared/models/changes";
import type { WorkingTreeFile } from "../../shared/store/commit-store";

export interface FileItemProps {
  file: WorkingTreeFile;
  selected: boolean;
  highlighted: boolean;
  showPath?: boolean;
  showCheckbox?: boolean;
  onToggle: () => void;
  onContextMenu: (e: React.MouseEvent) => void;
  onShowDiff: () => void;
  onClick: (e: React.MouseEvent) => void;
}

export function FileItem({
  file,
  selected,
  highlighted,
  showPath = true,
  showCheckbox = true,
  onToggle,
  onContextMenu,
  onShowDiff,
  onClick,
}: FileItemProps) {
  const parts = file.path.split("/");
  const fileName = parts.pop() || parts.pop() || file.path;
  const dirPath = parts.length > 0 ? parts.join("/") : "";

  const statusColor = getStatusColor(file.status);

  return (
    <div
      className={`commit-file-item ${highlighted ? "highlighted" : ""}`}
      role="button"
      tabIndex={0}
      onKeyDown={(event) => {
        if (event.key === "Enter") onShowDiff();
      }}
      onClick={onClick}
      onDoubleClick={onShowDiff}
      onContextMenu={(e) => {
        e.preventDefault();
        e.stopPropagation();
        onContextMenu(e);
      }}
    >
      {showCheckbox && file.status !== "incoming" && (
        <input
          type="checkbox"
          className="commit-file-checkbox"
          aria-label={t("Commit {0}", file.path)}
          disabled={!canCommit(file)}
          onClick={(event) => event.stopPropagation()}
          checked={selected}
          onChange={onToggle}
        />
      )}
      <span className="changes-file-indent" />
      <span
        className="commit-file-name"
        title={file.path}
        style={{ color: statusColor }}
      >
        {fileName}
      </span>
      {showPath && dirPath && (
        <span className="commit-file-path" title={dirPath}>
          {dirPath}
        </span>
      )}
    </div>
  );
}

function getStatusColor(status: WorkingTreeFile["status"]): string {
  switch (status) {
    case "added":
      return "var(--add)";
    case "untracked":
      return "var(--vscode-gitDecoration-deletedResourceForeground)";
    case "modified":
      return "var(--mod)";
    case "deleted":
      return "var(--vscode-gitDecoration-ignoredResourceForeground)";
    case "renamed":
      return "var(--vscode-gitDecoration-conflictingResourceForeground)";
    case "conflicted":
      return "var(--vscode-gitDecoration-deletedResourceForeground)";
    default:
      return "inherit";
  }
}
