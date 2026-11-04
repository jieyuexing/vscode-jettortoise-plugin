import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import {
  getFileIcon,
  IconFolder,
  IconFolderOpen,
} from "../../panel/utils/file-icons";
import type { DiffFile } from "../types/git";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const STATUS_COLORS: Record<string, string> = {
  added: "var(--vscode-gitDecoration-addedResourceForeground)",
  modified: "var(--vscode-gitDecoration-modifiedResourceForeground)",
  deleted: "var(--vscode-gitDecoration-ignoredResourceForeground)",
  renamed: "var(--vscode-gitDecoration-conflictingResourceForeground)",
  copied: "var(--vscode-gitDecoration-conflictingResourceForeground)",
  conflicts: "var(--vscode-gitDecoration-deletedResourceForeground)",
};

// ---------------------------------------------------------------------------
// Tree data structure
// ---------------------------------------------------------------------------

export interface FileTreeNode {
  name: string;
  fullPath: string;
  children: FileTreeNode[];
  file?: DiffFile;
  isLeaf: boolean;
  fileCount: number;
}

export function buildFileTree(files: DiffFile[]): FileTreeNode[] {
  const roots: FileTreeNode[] = [];
  const byPath = new Map<string, FileTreeNode>();

  for (const file of files) {
    const filePath = file.newPath || file.oldPath;
    const segments = filePath.split("/");
    let siblings = roots;

    for (let i = 0; i < segments.length; i++) {
      const seg = segments[i];
      const isLast = i === segments.length - 1;
      const fullPath = segments.slice(0, i + 1).join("/");

      const key = `${isLast ? "file" : "dir"}:${fullPath}`;
      const existing = byPath.get(key);

      if (existing) {
        siblings = existing.children;
      } else {
        const node: FileTreeNode = {
          name: seg,
          fullPath,
          children: [],
          isLeaf: isLast,
          file: isLast ? file : undefined,
          fileCount: 0,
        };
        byPath.set(key, node);
        siblings.push(node);
        siblings = node.children;
      }
    }
  }

  computeFileCount(roots);
  sortFileTreeNodes(roots);
  compactTree(roots);
  return roots;
}

function computeFileCount(nodes: FileTreeNode[]): number {
  let total = 0;
  for (const node of nodes) {
    if (node.isLeaf) {
      node.fileCount = 1;
      total += 1;
    } else {
      node.fileCount = computeFileCount(node.children);
      total += node.fileCount;
    }
  }
  return total;
}

const fileOrder = new Intl.Collator(undefined, { sensitivity: "base" });
function sortFileTreeNodes(nodes: FileTreeNode[]): void {
  nodes.sort((a, b) => {
    if (a.isLeaf !== b.isLeaf) return a.isLeaf ? 1 : -1;
    return fileOrder.compare(a.name, b.name);
  });
  for (const node of nodes) {
    if (!node.isLeaf && node.children.length > 0) {
      sortFileTreeNodes(node.children);
    }
  }
}

function compactTree(nodes: FileTreeNode[]): void {
  for (const node of nodes) {
    while (
      !node.isLeaf &&
      node.children.length === 1 &&
      !node.children[0].isLeaf
    ) {
      const child = node.children[0];
      node.name = `${node.name}/${child.name}`;
      node.fullPath = child.fullPath;
      node.children = child.children;
      node.fileCount = child.fileCount;
    }
    if (!node.isLeaf) {
      compactTree(node.children);
    }
  }
}

// ---------------------------------------------------------------------------
// Collect visible file paths in render order (for range selection)
// ---------------------------------------------------------------------------

export function collectVisibleFilePaths(
  nodes: FileTreeNode[],
  collapsed: Record<string, boolean>,
): string[] {
  const result: string[] = [];
  function walk(nodeList: FileTreeNode[]) {
    for (const node of nodeList) {
      if (node.isLeaf && node.file) {
        result.push(node.file.newPath || node.file.oldPath);
      } else {
        if (!(collapsed[node.fullPath] ?? false)) {
          walk(node.children);
        }
      }
    }
  }
  walk(nodes);
  return result;
}

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

export interface FileTreeProps {
  virtualized?: boolean;
  files: DiffFile[];
  viewMode: "tree" | "flat";
  selectedFiles: string[];
  onFileClick: (e: React.MouseEvent, file: DiffFile) => void;
  onFileDoubleClick?: (file: DiffFile) => void;
  onFileContextMenu?: (e: React.MouseEvent, file: DiffFile) => void;
  collapsed?: Record<string, boolean>;
  onToggle?: (key: string) => void;
  renderExtraColumns?: (file: DiffFile) => React.ReactNode;
  renderDirExtra?: (dir: FileTreeNode) => React.ReactNode;
  statusColorOverride?: (file: DiffFile) => string | undefined;
}

// ---------------------------------------------------------------------------
// FileTree component
// ---------------------------------------------------------------------------

export function FileTree({
  virtualized = false,
  files,
  viewMode,
  selectedFiles,
  onFileClick,
  onFileDoubleClick,
  onFileContextMenu,
  collapsed = {},
  onToggle,
  renderExtraColumns,
  renderDirExtra,
  statusColorOverride,
}: FileTreeProps) {
  const tree = useMemo(() => buildFileTree(files), [files]);

  if (virtualized)
    return (
      <VirtualFileTree
        tree={tree}
        files={files}
        viewMode={viewMode}
        selectedFiles={selectedFiles}
        onFileClick={onFileClick}
        onFileDoubleClick={onFileDoubleClick}
        onFileContextMenu={onFileContextMenu}
        collapsed={collapsed}
        onToggle={onToggle}
        renderExtraColumns={renderExtraColumns}
        renderDirExtra={renderDirExtra}
        statusColorOverride={statusColorOverride}
      />
    );
  if (viewMode === "tree") {
    return (
      <TreeView
        nodes={tree}
        depth={0}
        collapsed={collapsed}
        onToggle={onToggle ?? (() => {})}
        selectedFiles={selectedFiles}
        onFileClick={onFileClick}
        onFileDoubleClick={onFileDoubleClick}
        onFileContextMenu={onFileContextMenu}
        renderExtraColumns={renderExtraColumns}
        renderDirExtra={renderDirExtra}
        statusColorOverride={statusColorOverride}
      />
    );
  }

  return (
    <FlatView
      files={files}
      selectedFiles={selectedFiles}
      onFileClick={onFileClick}
      onFileDoubleClick={onFileDoubleClick}
      onFileContextMenu={onFileContextMenu}
      renderExtraColumns={renderExtraColumns}
      statusColorOverride={statusColorOverride}
    />
  );
}

// 沿用提交树的固定行高窗口，只创建可见 DOM；折叠和选择仍使用完整文件模型。
function VirtualFileTree({
  tree,
  ...props
}: FileTreeProps & { tree: FileTreeNode[] }) {
  const ref = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({
    top: 0,
    height: 400,
    rowHeight: 22,
  });
  const rows = useMemo(() => {
    const result: { node: FileTreeNode; depth: number }[] = [];
    const visit = (nodes: FileTreeNode[], depth: number) => {
      for (const node of nodes) {
        result.push({ node, depth });
        if (!node.isLeaf && !props.collapsed?.[node.fullPath])
          visit(node.children, depth + 1);
      }
    };
    if (props.viewMode === "tree") visit(tree, 0);
    else {
      for (const file of props.files) {
        const fullPath = file.newPath || file.oldPath;
        result.push({
          node: {
            name: fullPath.split("/").pop() ?? fullPath,
            fullPath,
            children: [],
            file,
            isLeaf: true,
            fileCount: 1,
          },
          depth: 0,
        });
      }
      result.sort((a, b) => fileOrder.compare(a.node.name, b.node.name));
    }
    return result;
  }, [tree, props.files, props.viewMode, props.collapsed]);
  useEffect(() => {
    const element = ref.current;
    if (!element) return;
    const resize = () =>
      setViewport((value) => ({
        ...value,
        height: element.clientHeight || 400,
        rowHeight:
          Number.parseFloat(
            getComputedStyle(element).getPropertyValue("--etech-row-height"),
          ) || 22,
      }));
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  useLayoutEffect(() => {
    const max = Math.max(0, rows.length * viewport.rowHeight - viewport.height);
    if (viewport.top > max) {
      if (ref.current) ref.current.scrollTop = max;
      setViewport((value) => ({ ...value, top: max }));
    }
  }, [rows.length, viewport.height, viewport.rowHeight, viewport.top]);
  const start = Math.max(
    0,
    Math.min(
      rows.length - 1,
      Math.floor(viewport.top / viewport.rowHeight) - 6,
    ),
  );
  const end = Math.min(
    rows.length,
    Math.ceil((viewport.top + viewport.height) / viewport.rowHeight) + 6,
  );
  return (
    <div
      ref={ref}
      className="virtual-file-tree"
      style={{ height: "100%", overflow: "auto", overflowX: "hidden" }}
      onScroll={(event) => {
        const top = event.currentTarget.scrollTop;
        setViewport((value) => ({ ...value, top }));
      }}
    >
      <div
        style={{
          height: rows.length * viewport.rowHeight,
          position: "relative",
        }}
      >
        {rows.slice(start, end).map(({ node, depth }, offset) => (
          <div
            key={node.fullPath}
            style={{
              position: "absolute",
              top: (start + offset) * viewport.rowHeight,
              height: viewport.rowHeight,
              width: "100%",
            }}
          >
            <FileTreeNodeView
              {...props}
              node={node}
              depth={depth}
              collapsed={props.collapsed ?? {}}
              onToggle={props.onToggle ?? (() => {})}
              shallow
              flat={props.viewMode === "flat"}
            />
          </div>
        ))}
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tree View
// ---------------------------------------------------------------------------

function TreeView({
  nodes,
  depth,
  collapsed,
  onToggle,
  selectedFiles,
  onFileClick,
  onFileDoubleClick,
  onFileContextMenu,
  renderExtraColumns,
  renderDirExtra,
  statusColorOverride,
}: {
  nodes: FileTreeNode[];
  depth: number;
  collapsed: Record<string, boolean>;
  onToggle: (key: string) => void;
  selectedFiles: string[];
  onFileClick: (e: React.MouseEvent, file: DiffFile) => void;
  onFileDoubleClick?: (file: DiffFile) => void;
  onFileContextMenu?: (e: React.MouseEvent, file: DiffFile) => void;
  renderExtraColumns?: (file: DiffFile) => React.ReactNode;
  renderDirExtra?: (dir: FileTreeNode) => React.ReactNode;
  statusColorOverride?: (file: DiffFile) => string | undefined;
}) {
  return (
    <>
      {nodes.map((node) => (
        <FileTreeNodeView
          key={node.fullPath}
          node={node}
          depth={depth}
          collapsed={collapsed}
          onToggle={onToggle}
          selectedFiles={selectedFiles}
          onFileClick={onFileClick}
          onFileDoubleClick={onFileDoubleClick}
          onFileContextMenu={onFileContextMenu}
          renderExtraColumns={renderExtraColumns}
          renderDirExtra={renderDirExtra}
          statusColorOverride={statusColorOverride}
        />
      ))}
    </>
  );
}

function FileTreeNodeView({
  shallow,
  flat,
  node,
  depth,
  collapsed,
  onToggle,
  selectedFiles,
  onFileClick,
  onFileDoubleClick,
  onFileContextMenu,
  renderExtraColumns,
  renderDirExtra,
  statusColorOverride,
}: {
  shallow?: boolean;
  flat?: boolean;
  node: FileTreeNode;
  depth: number;
  collapsed: Record<string, boolean>;
  onToggle: (key: string) => void;
  selectedFiles: string[];
  onFileClick: (e: React.MouseEvent, file: DiffFile) => void;
  onFileDoubleClick?: (file: DiffFile) => void;
  onFileContextMenu?: (e: React.MouseEvent, file: DiffFile) => void;
  renderExtraColumns?: (file: DiffFile) => React.ReactNode;
  renderDirExtra?: (dir: FileTreeNode) => React.ReactNode;
  statusColorOverride?: (file: DiffFile) => string | undefined;
}) {
  if (node.isLeaf && node.file) {
    const filePath = node.file.newPath || node.file.oldPath;
    return (
      <FileRow
        file={node.file}
        name={node.name}
        directoryHint={
          flat ? filePath.split("/").slice(0, -1).join("/") : undefined
        }
        depth={depth}
        isSelected={selectedFiles.includes(filePath)}
        onClick={(e) => node.file && onFileClick(e, node.file)}
        onDoubleClick={
          onFileDoubleClick
            ? () => node.file && onFileDoubleClick(node.file)
            : undefined
        }
        onContextMenu={
          onFileContextMenu
            ? (e) => node.file && onFileContextMenu(e, node.file)
            : undefined
        }
        renderExtraColumns={renderExtraColumns}
        statusColorOverride={statusColorOverride}
      />
    );
  }

  const isCollapsed = collapsed[node.fullPath] ?? false;

  return (
    <div>
      <div
        className="selectable-row"
        onClick={() => onToggle(node.fullPath)}
        style={{
          height: "var(--etech-row-height)",
          padding: `0 12px 0 calc(12px + ${depth} * var(--etech-indent))`,
          userSelect: "none",
          display: "flex",
          alignItems: "center",
          gap: 4,
        }}
      >
        {isCollapsed ? (
          <IconFolder
            style={{
              flexShrink: 0,
              width: 16,
              height: 16,
            }}
          />
        ) : (
          <IconFolderOpen
            style={{
              flexShrink: 0,
              width: 16,
              height: 16,
            }}
          />
        )}
        <span
          style={{
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
          }}
        >
          {node.name}
        </span>
        {renderDirExtra ? (
          renderDirExtra(node)
        ) : (
          <span
            style={{
              marginLeft: "auto",
              fontSize: "0.8em",
              opacity: 0.5,
              flexShrink: 0,
            }}
          >
            {node.fileCount} {node.fileCount === 1 ? "file" : "files"}
          </span>
        )}
      </div>
      {!shallow && !isCollapsed && (
        <TreeView
          nodes={node.children}
          depth={depth + 1}
          collapsed={collapsed}
          onToggle={onToggle}
          selectedFiles={selectedFiles}
          onFileClick={onFileClick}
          onFileDoubleClick={onFileDoubleClick}
          onFileContextMenu={onFileContextMenu}
          renderExtraColumns={renderExtraColumns}
          renderDirExtra={renderDirExtra}
          statusColorOverride={statusColorOverride}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// File row (shared between tree and flat)
// ---------------------------------------------------------------------------

function FileRow({
  file,
  name,
  depth,
  isSelected,
  onClick,
  onDoubleClick,
  onContextMenu,
  directoryHint,
  renderExtraColumns,
  statusColorOverride,
}: {
  file: DiffFile;
  name: string;
  depth: number;
  isSelected: boolean;
  onClick: (e: React.MouseEvent) => void;
  onDoubleClick?: () => void;
  onContextMenu?: (e: React.MouseEvent) => void;
  directoryHint?: string;
  renderExtraColumns?: (file: DiffFile) => React.ReactNode;
  statusColorOverride?: (file: DiffFile) => string | undefined;
}) {
  const defaultColor = STATUS_COLORS[file.status] ?? undefined;
  const statusColor = statusColorOverride
    ? (statusColorOverride(file) ?? defaultColor)
    : defaultColor;
  const FileIcon = getFileIcon(name);

  return (
    <div
      className={`selectable-row${isSelected ? " selected" : ""}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      onContextMenu={(e) => {
        if (onContextMenu) {
          e.preventDefault();
          e.stopPropagation();
          onContextMenu(e);
        }
      }}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 4,
        height: "var(--etech-row-height)",
        padding: `0 12px 0 calc(12px + ${depth} * var(--etech-indent))`,
        color: statusColor,
      }}
    >
      <FileIcon style={{ flexShrink: 0, width: 16, height: 16 }} />
      <span
        style={{
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
        }}
      >
        {name}
      </span>
      {directoryHint && (
        <span
          style={{
            color: "var(--description-fg)",
            fontSize: "0.85em",
            overflow: "hidden",
            textOverflow: "ellipsis",
            whiteSpace: "nowrap",
            opacity: 0.6,
          }}
        >
          {directoryHint}
        </span>
      )}
      {renderExtraColumns?.(file)}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Flat View
// ---------------------------------------------------------------------------

function FlatView({
  files,
  selectedFiles,
  onFileClick,
  onFileDoubleClick,
  onFileContextMenu,
  renderExtraColumns,
  statusColorOverride,
}: {
  files: DiffFile[];
  selectedFiles: string[];
  onFileClick: (e: React.MouseEvent, file: DiffFile) => void;
  onFileDoubleClick?: (file: DiffFile) => void;
  onFileContextMenu?: (e: React.MouseEvent, file: DiffFile) => void;
  renderExtraColumns?: (file: DiffFile) => React.ReactNode;
  statusColorOverride?: (file: DiffFile) => string | undefined;
}) {
  const sorted = useMemo(() => {
    return [...files].sort((a, b) => {
      const nameA = (a.newPath || a.oldPath).split("/").pop() ?? "";
      const nameB = (b.newPath || b.oldPath).split("/").pop() ?? "";
      return fileOrder.compare(nameA, nameB);
    });
  }, [files]);

  return (
    <>
      {sorted.map((file) => {
        const filePath = file.newPath || file.oldPath;
        const parts = filePath.split("/");
        const fileName = parts.pop() ?? filePath;
        const dirPath = parts.join("/");
        const isSelected = selectedFiles.includes(filePath);

        return (
          <FileRow
            key={filePath}
            file={file}
            name={fileName}
            depth={0}
            isSelected={isSelected}
            onClick={(e) => onFileClick(e, file)}
            onDoubleClick={
              onFileDoubleClick ? () => onFileDoubleClick(file) : undefined
            }
            onContextMenu={
              onFileContextMenu ? (e) => onFileContextMenu(e, file) : undefined
            }
            directoryHint={dirPath || undefined}
            renderExtraColumns={renderExtraColumns}
            statusColorOverride={statusColorOverride}
          />
        );
      })}
    </>
  );
}
