import {
  buildVcsFileTree,
  collectVisibleVcsFilePaths,
  VCS_STATUS_COLORS,
  VcsFileTree,
  type VcsFileTreeNode,
  type VcsFileTreeProps,
} from "../../../../packages/vcs-ui/src";
import { getFileIcon } from "../../panel/utils/file-icons";
import { t } from "../i18n";
import type { DiffFile } from "../types/git";

/** Git adapter around the VCS-neutral file tree. */
export type FileTreeNode = VcsFileTreeNode<DiffFile>;
export type FileTreeProps = Omit<
  VcsFileTreeProps<DiffFile>,
  "renderFileIcon" | "formatFileCount"
>;
export const STATUS_COLORS = VCS_STATUS_COLORS;

export function buildFileTree(files: DiffFile[]): FileTreeNode[] {
  return buildVcsFileTree(files);
}

export function collectVisibleFilePaths(
  nodes: FileTreeNode[],
  collapsed: Record<string, boolean>,
): string[] {
  return collectVisibleVcsFilePaths(nodes, collapsed);
}

export function FileTree(props: FileTreeProps) {
  return (
    <VcsFileTree
      {...props}
      renderFileIcon={getFileIcon}
      formatFileCount={(count) =>
        t("common.fileCount", {
          count,
          plural: count === 1 ? "" : "s",
        })
      }
    />
  );
}
