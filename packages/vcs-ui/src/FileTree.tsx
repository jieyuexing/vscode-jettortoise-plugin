import { type ComponentType, type MouseEvent, type ReactNode, type SVGProps, useMemo } from "react";
import type { VcsChangedFile } from "./types";

export const VCS_STATUS_COLORS: Record<string, string> = {
  added: "#6a8759", modified: "#6897bb", deleted: "#6c6c6c",
  renamed: "#b9b462", copied: "#b9b462", conflicts: "#d1675a",
};

export interface VcsFileTreeNode<T extends VcsChangedFile> {
  name: string;
  fullPath: string;
  children: VcsFileTreeNode<T>[];
  file?: T;
  isLeaf: boolean;
  fileCount: number;
}

export interface VcsFileTreeProps<T extends VcsChangedFile> {
  files: T[];
  viewMode: "tree" | "flat";
  selectedFiles: string[];
  onFileClick: (event: MouseEvent, file: T) => void;
  onFileDoubleClick?: (file: T) => void;
  onFileContextMenu?: (event: MouseEvent, file: T) => void;
  collapsed?: Record<string, boolean>;
  onToggle?: (key: string) => void;
  renderExtraColumns?: (file: T) => ReactNode;
  renderDirExtra?: (dir: VcsFileTreeNode<T>) => ReactNode;
  statusColorOverride?: (file: T) => string | undefined;
  renderFileIcon?: (fileName: string) => ComponentType<SVGProps<SVGSVGElement>>;
  /** The VCS host owns all user-visible words, including file counts. */
  formatFileCount: (count: number) => string;
}

function pathFor(file: VcsChangedFile): string {
  return file.newPath || file.oldPath || "";
}

export function buildVcsFileTree<T extends VcsChangedFile>(files: T[]): VcsFileTreeNode<T>[] {
  const roots: VcsFileTreeNode<T>[] = [];
  for (const file of files) {
    const segments = pathFor(file).split("/").filter(Boolean);
    let siblings = roots;
    segments.forEach((name, index) => {
      const isLeaf = index === segments.length - 1;
      const fullPath = segments.slice(0, index + 1).join("/");
      let node = siblings.find((candidate) => candidate.name === name && candidate.isLeaf === isLeaf);
      if (!node && !isLeaf) node = siblings.find((candidate) => candidate.name === name && !candidate.isLeaf);
      if (!node) {
        node = { name, fullPath, children: [], file: isLeaf ? file : undefined, isLeaf, fileCount: 0 };
        siblings.push(node);
      }
      siblings = node.children;
    });
  }
  const countAndSort = (nodes: VcsFileTreeNode<T>[]): number => {
    let count = 0;
    nodes.sort((a, b) => a.isLeaf === b.isLeaf ? a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) : a.isLeaf ? 1 : -1);
    for (const node of nodes) {
      node.fileCount = node.isLeaf ? 1 : countAndSort(node.children);
      count += node.fileCount;
    }
    return count;
  };
  countAndSort(roots);
  const compact = (nodes: VcsFileTreeNode<T>[]) => nodes.forEach((node) => {
    while (!node.isLeaf && node.children.length === 1 && !node.children[0].isLeaf) {
      const child = node.children[0];
      node.name = `${node.name}/${child.name}`;
      node.fullPath = child.fullPath;
      node.children = child.children;
      node.fileCount = child.fileCount;
    }
    if (!node.isLeaf) compact(node.children);
  });
  compact(roots);
  return roots;
}

export function collectVisibleVcsFilePaths<T extends VcsChangedFile>(nodes: VcsFileTreeNode<T>[], collapsed: Record<string, boolean>): string[] {
  return nodes.flatMap((node) => node.isLeaf && node.file
    ? [pathFor(node.file)]
    : collapsed[node.fullPath] ? [] : collectVisibleVcsFilePaths(node.children, collapsed));
}

export function VcsFileTree<T extends VcsChangedFile>(props: VcsFileTreeProps<T>) {
  const tree = useMemo(() => buildVcsFileTree(props.files), [props.files]);
  if (props.viewMode === "flat") {
    return <FlatFiles {...props} />;
  }
  return <TreeFiles {...props} nodes={tree} depth={0} />;
}

function TreeFiles<T extends VcsChangedFile>({ nodes, depth, ...props }: VcsFileTreeProps<T> & { nodes: VcsFileTreeNode<T>[]; depth: number }) {
  return <>{nodes.map((node) => {
    if (node.isLeaf && node.file) return <FileRow key={node.fullPath} file={node.file} name={node.name} depth={depth} {...props} />;
    const collapsed = props.collapsed?.[node.fullPath] ?? false;
    return <div key={node.fullPath}>
      <button
        type="button"
        className="selectable-row vcs-ui-tree-folder"
        aria-expanded={!collapsed}
        onClick={() => props.onToggle?.(node.fullPath)}
        style={{ padding: `2px 12px 2px ${12 + depth * 16}px` }}
      >
        <FolderIcon open={!collapsed} />
        <span className="vcs-ui-tree-label">{node.name}</span>
        {props.renderDirExtra?.(node) ?? (
          <span className="vcs-ui-tree-count">
            {props.formatFileCount(node.fileCount)}
          </span>
        )}
      </button>
      {!collapsed && <TreeFiles {...props} nodes={node.children} depth={depth + 1} />}
    </div>;
  })}</>;
}

function FlatFiles<T extends VcsChangedFile>(props: VcsFileTreeProps<T>) {
  const files = useMemo(() => [...props.files].sort((a, b) => pathFor(a).localeCompare(pathFor(b), undefined, { sensitivity: "base" })), [props.files]);
  return <>{files.map((file) => {
    const path = pathFor(file);
    const parts = path.split("/");
    return <FileRow key={path} {...props} file={file} name={parts.at(-1) || path} directoryHint={parts.slice(0, -1).join("/")} depth={0} />;
  })}</>;
}

function FileRow<T extends VcsChangedFile>({ file, name, depth, directoryHint, ...props }: VcsFileTreeProps<T> & { file: T; name: string; depth: number; directoryHint?: string }) {
  const path = pathFor(file);
  const Icon = props.renderFileIcon?.(name);
  const color = props.statusColorOverride?.(file) ?? VCS_STATUS_COLORS[file.status ?? ""];
  return <div
    className={`selectable-row${props.selectedFiles.includes(path) ? " selected" : ""}`}
    onClick={(event) => props.onFileClick(event, file)}
    onDoubleClick={() => props.onFileDoubleClick?.(file)}
    onContextMenu={(event) => { if (props.onFileContextMenu) { event.preventDefault(); event.stopPropagation(); props.onFileContextMenu(event, file); } }}
    style={{ display: "flex", alignItems: "center", gap: 4, padding: `2px 12px 2px ${12 + depth * 16}px`, color }}
  >
    {Icon ? <Icon style={{ flexShrink: 0, width: 16, height: 16 }} /> : <GenericFileIcon />}
    <span className="vcs-ui-tree-label">{name}</span>
    {directoryHint && <span className="vcs-ui-tree-directory">{directoryHint}</span>}
    {props.renderExtraColumns?.(file)}
  </div>;
}

function FolderIcon({ open }: { open: boolean }) {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ color: "#8c8c8c", flexShrink: 0 }}>
    <path d="M2.5 4.5a1 1 0 0 1 1-1h3l1.4 1.5H12.5a1 1 0 0 1 1 1v6.5a1 1 0 0 1-1 1h-9a1 1 0 0 1-1-1z" fill="currentColor" fillOpacity=".15" stroke="currentColor" />
    {open && <path d="M2.1 6.7h11.8" stroke="currentColor" />}
  </svg>;
}

function GenericFileIcon() {
  return <svg aria-hidden="true" width="16" height="16" viewBox="0 0 16 16" fill="none" style={{ color: "var(--description-fg)", flexShrink: 0 }}><path d="M4 1.5h5l3 3v10H4z" stroke="currentColor" /><path d="M9 1.5v3h3" stroke="currentColor" /></svg>;
}
