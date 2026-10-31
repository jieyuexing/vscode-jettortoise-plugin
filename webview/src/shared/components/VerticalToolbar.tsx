import type { HTMLAttributes } from "react";
import "./panel-chrome.css";

/** 30px 工具列；短面板保留滚动与键盘焦点，不压缩按钮。 */
export function VerticalToolbar({
  className = "",
  children,
  ...props
}: HTMLAttributes<HTMLDivElement>) {
  return (
    <div role="toolbar" {...props} className={`panel-vtool ${className}`}>
      {children}
    </div>
  );
}
