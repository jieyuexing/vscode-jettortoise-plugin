import { type KeyboardEvent, useMemo, useState } from "react";
import { VcsContextMenu } from "./ContextMenu";
import type { VcsAction } from "./types";

export type VcsRepositoryKind = "git" | "cvs";

/** A host-supplied catalog entry. Paths are display data only; actions use `id`. */
export interface VcsRepositoryListItem {
  id: string;
  name: string;
  kind: VcsRepositoryKind;
  ref?: string;
  relativePath?: string;
  path?: string;
  depth?: number;
  current?: boolean;
  unavailableReason?: string;
  status?: "idle" | "scanning" | "updating" | "error" | "success";
  /** Host-provided, already localized outcome shown without a second feedback surface. */
  statusMessage?: string;
}

export interface VcsRepositoryListLabels {
  search: string;
  add: string;
  scan: string;
  restore: string;
  open: string;
  openCommit: string;
  update: string;
  refresh: string;
  copyPath: string;
  remove: string;
  unavailable: string;
  empty: string;
}

export interface VcsRepositoryListProps {
  items: readonly VcsRepositoryListItem[];
  labels: VcsRepositoryListLabels;
  currentId?: string;
  onOpen?: (id: string) => void;
  onOpenCommit?: (id: string) => void;
  onUpdate?: (id: string) => void;
  onRefresh?: (id: string) => void;
  onCopyPath?: (id: string) => void;
  onRemove?: (id: string) => void;
  onAdd?: () => void;
  onScan?: () => void;
  onRestore?: () => void;
}

/**
 * Presentational repository catalog. It never receives a cwd or executes an
 * operation: consumers must map the opaque id back to a registered host entry.
 */
export function VcsRepositoryList({
  items,
  labels,
  currentId,
  onOpen,
  onOpenCommit,
  onUpdate,
  onRefresh,
  onCopyPath,
  onRemove,
  onAdd,
  onScan,
  onRestore,
}: VcsRepositoryListProps) {
  const [query, setQuery] = useState("");
  const [menu, setMenu] = useState<{ item: VcsRepositoryListItem; x: number; y: number } | null>(null);
  const visible = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return items;
    return items.filter((item) =>
      [item.name, item.kind, item.ref, item.relativePath, item.path]
        .filter(Boolean)
        .some((value) => value?.toLocaleLowerCase().includes(needle)),
    );
  }, [items, query]);
  const execute = (id: string, action: string) => {
    switch (action) {
      case "open": onOpen?.(id); break;
      case "commit": onOpenCommit?.(id); break;
      case "update": onUpdate?.(id); break;
      case "refresh": onRefresh?.(id); break;
      case "copy": onCopyPath?.(id); break;
      case "remove": onRemove?.(id); break;
    }
  };
  const actions = (item: VcsRepositoryListItem): VcsAction[] => [
    { id: "open", label: labels.open },
    { id: "commit", label: labels.openCommit },
    { id: "update", label: labels.update, disabled: Boolean(item.unavailableReason || item.status === "updating") },
    { id: "refresh", label: labels.refresh, disabled: Boolean(item.unavailableReason) },
    { id: "copy", label: labels.copyPath },
    { id: "remove", label: labels.remove, danger: true, separatorBefore: true },
  ];
  const keyOpen = (event: KeyboardEvent<HTMLButtonElement>, item: VcsRepositoryListItem) => {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen?.(item.id);
    }
  };
  return (
    <section className="vcs-ui-repository-list" aria-label={labels.search}>
      <div className="vcs-ui-repository-tools">
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder={labels.search}
          aria-label={labels.search}
        />
        <button type="button" className="panel-toggle-btn" aria-label={labels.add} onClick={onAdd}>+</button>
        <button type="button" className="panel-toggle-btn" aria-label={labels.scan} onClick={onScan}>↻</button>
        <button type="button" className="panel-toggle-btn" aria-label={labels.restore} onClick={onRestore}>↶</button>
      </div>
      <div className="vcs-ui-repository-rows" role="list">
        {visible.length === 0 && <p className="vcs-ui-repository-empty">{labels.empty}</p>}
        {visible.map((item) => {
          const current = item.current || item.id === currentId;
          return (
            <button
              key={item.id}
              type="button"
              role="listitem"
              className={`vcs-ui-repository-row${current ? " selected" : ""}`}
              title={item.path || item.relativePath || item.name}
              style={{ paddingInlineStart: 8 + Math.max(0, item.depth ?? 0) * 12 }}
              onClick={() => onOpen?.(item.id)}
              onKeyDown={(event) => keyOpen(event, item)}
              onContextMenu={(event) => {
                event.preventDefault();
                setMenu({ item, x: event.clientX, y: event.clientY });
              }}
            >
              <span className={`vcs-ui-repository-kind ${item.kind}`}>{item.kind === "git" ? "Git" : "CVS"}</span>
              <span className="vcs-ui-repository-name">{item.name}{item.relativePath && <small className="vcs-ui-repository-relative"> · {item.relativePath}</small>}</span>
              <span className="vcs-ui-repository-ref">{item.ref || item.relativePath || item.kind.toUpperCase()}</span>
              {item.status && item.status !== "idle" && <span className={`vcs-ui-repository-status ${item.status}`} aria-label={item.statusMessage || item.status} title={item.statusMessage}>●</span>}
              {item.unavailableReason && <span className="vcs-ui-repository-warning" title={item.unavailableReason}>!</span>}
            </button>
          );
        })}
      </div>
      {menu && (
        <VcsContextMenu
          position={{ x: menu.x, y: menu.y }}
          items={actions(menu.item)}
          capabilities={{}}
          onSelect={(action) => execute(menu.item.id, action)}
          onClose={() => setMenu(null)}
        />
      )}
    </section>
  );
}
