import type { ReactNode } from "react";

/**
 * A revision as presented by a VCS. `revisionId` is intentionally opaque: Git
 * consumers can use a hash, while CVS consumers can use values such as 1.42.
 */
export interface VcsRevision {
  revisionId: string;
  shortRevisionId?: string;
  subject: string;
  body?: string;
  author?: {
    name: string;
    email?: string;
  };
  timestamp?: string;
  references?: VcsReference[];
}

export interface VcsReference {
  name: string;
  kind: "branch" | "remote" | "tag" | "head" | "other";
}

/** A changed file that can be rendered by the shared file tree. */
export interface VcsChangedFile {
  oldPath?: string;
  newPath?: string;
  status?: string;
}

export interface VcsCapabilities {
  checkoutRevision?: boolean;
  compareRevision?: boolean;
  copyRevision?: boolean;
  createBranch?: boolean;
  deleteBranch?: boolean;
  merge?: boolean;
  update?: boolean;
  commit?: boolean;
  rollback?: boolean;
  shelve?: boolean;
  push?: boolean;
  rebase?: boolean;
  cherryPick?: boolean;
}

export interface VcsAction {
  id: string;
  label: string;
  capability?: keyof VcsCapabilities;
  disabled?: boolean;
  danger?: boolean;
  separatorBefore?: boolean;
  icon?: ReactNode;
}

export interface VcsMenuPosition {
  x: number;
  y: number;
}
