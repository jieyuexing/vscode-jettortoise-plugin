import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import type { VcsAction, VcsCapabilities, VcsMenuPosition } from "./types";

export interface VcsContextMenuProps {
  position: VcsMenuPosition;
  items: readonly VcsAction[];
  capabilities: VcsCapabilities;
  onSelect: (actionId: string) => void;
  onClose: () => void;
}

/** A consumer-owned menu action list with capability-based presentation only. */
export function VcsContextMenu({
  position,
  items,
  capabilities,
  onSelect,
  onClose,
}: VcsContextMenuProps) {
  const menuRef = useRef<HTMLDivElement>(null);
  const [point, setPoint] = useState(position);
  const visibleItems = items.filter((item) => !item.capability || capabilities[item.capability]);

  useLayoutEffect(() => {
    const node = menuRef.current;
    if (!node) return;
    const rect = node.getBoundingClientRect();
    let top = position.y;
    if (top + rect.height > window.innerHeight) {
      top = position.y - rect.height >= 4
        ? position.y - rect.height
        : Math.max(4, window.innerHeight - rect.height - 4);
    }
    setPoint({
      x: Math.max(4, Math.min(position.x, window.innerWidth - rect.width - 4)),
      y: top,
    });
  }, [position]);
  useEffect(() => {
    const closeForEvent = (event: MouseEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const closeForKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    const closeForScroll = (event: Event) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target)) onClose();
    };
    document.addEventListener("mousedown", closeForEvent, true);
    document.addEventListener("contextmenu", closeForEvent, true);
    document.addEventListener("keydown", closeForKey);
    window.addEventListener("blur", onClose);
    document.addEventListener("scroll", closeForScroll, true);
    window.addEventListener("resize", onClose);
    return () => {
      document.removeEventListener("mousedown", closeForEvent, true);
      document.removeEventListener("contextmenu", closeForEvent, true);
      document.removeEventListener("keydown", closeForKey);
      window.removeEventListener("blur", onClose);
      document.removeEventListener("scroll", closeForScroll, true);
      window.removeEventListener("resize", onClose);
    };
  }, [onClose]);

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      className="vcs-ui-context-menu"
      style={{
        position: "fixed",
        left: point.x,
        top: point.y,
        zIndex: 9999,
      }}
    >
      {visibleItems.map((item) => (
        <div key={item.id}>
          {item.separatorBefore && (
            <div className="vcs-ui-context-menu-separator" role="separator" />
          )}
          <button
            type="button"
            role="menuitem"
            className={
              item.danger
                ? "vcs-ui-context-menu-item vcs-ui-context-menu-danger"
                : "vcs-ui-context-menu-item"
            }
            disabled={item.disabled}
            onClick={() => {
              if (!item.disabled) {
                onSelect(item.id);
                onClose();
              }
            }}
          >
            <span className="vcs-ui-context-menu-icon">{item.icon}</span>
            <span>{item.label}</span>
          </button>
        </div>
      ))}
    </div>,
    document.body,
  );
}
