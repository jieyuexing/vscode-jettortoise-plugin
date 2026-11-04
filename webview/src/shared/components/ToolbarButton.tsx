import type { ReactNode } from "react";
import "./panel-chrome.css";

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
/** 树行和工具栏共用图标按钮，显隐与尺寸由所在容器控制。 */
export function ToolbarButton({
  label,
  path,
  icon,
  action,
  disabled = false,
  active,
  className = "",
}: {
  label: string;
  path?: string;
  icon?: ReactNode;
  action: () => void;
  disabled?: boolean;
  active?: boolean;
  className?: string;
}) {
  return (
    <button
      type="button"
      title={label}
      aria-label={label}
      disabled={disabled}
      className={`panel-tool-button ${className} ${active ? "active" : ""}`}
      aria-pressed={active}
      onClick={action}
    >
      {icon ?? (path && <Icon path={path} />)}
    </button>
  );
}
