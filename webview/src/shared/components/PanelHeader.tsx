import type { HTMLAttributes } from "react";
import "./panel-chrome.css";

/** 面板标题与页内子页签共用一行，保留调用方的动作和可访问属性。 */
export function PanelHeader({
  title,
  className = "",
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div {...props} className={`panel-header ${className}`}>
      {title && <strong className="panel-header-title">{title}</strong>}
      {children}
    </div>
  );
}
