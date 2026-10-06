import type { VcsCapabilities } from "../../../packages/vcs-ui/src/types";

/** Presentation capabilities only; operation semantics remain in the Git Host. */
export const GIT_UI_CAPABILITIES: Readonly<VcsCapabilities> = {
  checkoutRevision: true,
  compareRevision: true,
  copyRevision: true,
  createBranch: true,
  deleteBranch: true,
  merge: true,
  update: true,
  commit: true,
  rollback: true,
  shelve: true,
  push: true,
  rebase: true,
  cherryPick: true,
};
