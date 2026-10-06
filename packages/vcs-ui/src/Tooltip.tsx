import { type ReactNode, useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

export interface VcsTooltipProps {
  text: string;
  children: ReactNode;
  delay?: number;
  position?: "top" | "bottom";
}

/** Tooltip that remains inside the webview viewport when used by either VCS. */
export function Tooltip({ text, children, delay = 300, position = "top" }: VcsTooltipProps) {
  const [visible, setVisible] = useState(false);
  const [coords, setCoords] = useState<{ top: number; left: number } | null>(null);
  const [actualPosition, setActualPosition] = useState(position);
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const containerRef = useRef<HTMLSpanElement>(null);
  const tooltipRef = useRef<HTMLSpanElement>(null);

  const hide = useCallback(() => {
    if (timerRef.current) clearTimeout(timerRef.current);
    timerRef.current = null;
    setVisible(false);
    setCoords(null);
  }, []);
  const show = useCallback(() => {
    timerRef.current = setTimeout(() => setVisible(true), delay);
  }, [delay]);

  useEffect(() => () => {
    if (timerRef.current) clearTimeout(timerRef.current);
  }, []);

  useEffect(() => {
    if (!visible || !containerRef.current) return;
    const rect = containerRef.current.getBoundingClientRect();
    const shownAtBottom = position === "top" && rect.top < 30;
    setActualPosition(shownAtBottom ? "bottom" : position);
    setCoords({
      top: shownAtBottom ? rect.bottom + 4 : rect.top - 4,
      left: rect.left + rect.width / 2,
    });
  }, [visible, position]);

  useEffect(() => {
    if (!visible || !coords || !tooltipRef.current) return;
    const rect = tooltipRef.current.getBoundingClientRect();
    const nextLeft = Math.min(Math.max(coords.left, rect.width / 2 + 4), window.innerWidth - rect.width / 2 - 4);
    if (nextLeft !== coords.left) setCoords({ ...coords, left: nextLeft });
  }, [visible, coords]);

  return (
    <span ref={containerRef} className="vcs-ui-tooltip-trigger" onMouseEnter={show} onMouseLeave={hide}>
      {children}
      {visible && coords && createPortal(
        <span
          ref={tooltipRef}
          role="tooltip"
          className="vcs-ui-tooltip"
          style={{
            position: "fixed", top: coords.top, left: coords.left,
            transform: actualPosition === "top" ? "translate(-50%, -100%)" : "translateX(-50%)",
            zIndex: 99999,
          }}
        >{text}</span>, document.body,
      )}
    </span>
  );
}
