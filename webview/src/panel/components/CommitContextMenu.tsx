import { useEffect, useState } from "react";
import {
  type VcsAction,
  VcsContextMenu,
} from "../../../../packages/vcs-ui/src";
import { bridge, bridgeWithProgress } from "../../shared/bridge";
import { GIT_UI_CAPABILITIES } from "../../shared/git-ui-adapter";
import { t } from "../../shared/i18n";
import { usePanelStore } from "../../shared/store/panel-store";
import type { Commit } from "../../shared/types/git";

// IntelliJ-style icons for commit context menu
function IconCopy() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <rect
        x="2.5"
        y="3.5"
        width="9"
        height="10"
        rx="1.5"
        stroke="currentColor"
      />
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M11 2h.6C12.37 2 13 2.63 13 3.4v.51c0 .03 0 .06 0 .09v7.55c.6-.44 1-1.15 1-1.95V3.4C14 2.07 12.93 1 11.6 1H6.4c-.8 0-1.51.39-1.95 1H6.4H11z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconCherryPick() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="5" cy="11.5" r="2.5" stroke="currentColor" />
      <circle cx="10.5" cy="10.5" r="2.5" stroke="currentColor" />
      <path
        d="M5 9C5 6 4 4 7 2"
        stroke="currentColor"
        strokeLinecap="round"
        fill="none"
      />
      <path
        d="M10.5 8C10.5 5.5 11 4 8 2"
        stroke="currentColor"
        strokeLinecap="round"
        fill="none"
      />
    </svg>
  );
}

function IconRevert() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path
        fillRule="evenodd"
        clipRule="evenodd"
        d="M5.85 1.85a.5.5 0 00-.7-.7L1.65 4.65 1.3 5l.35.35 3.5 3.5a.5.5 0 00.7-.7L3.21 5.5H10.5a3.5 3.5 0 010 7H5.5a.5.5 0 000 1h5a4.5 4.5 0 000-9H3.21l2.64-2.65z"
        fill="currentColor"
      />
    </svg>
  );
}

function IconBranch() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <circle cx="4.5" cy="4" r="2" stroke="currentColor" />
      <path
        d="M4.5 11.5H8.5C9.6 11.5 10.5 10.6 10.5 9.5V8"
        stroke="currentColor"
      />
      <path d="M4.5 6.5V14.5" stroke="currentColor" strokeLinecap="round" />
      <circle cx="10.5" cy="6" r="2" stroke="currentColor" />
    </svg>
  );
}

function IconTag() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
      <path d="M3 2.5h4.5l6 6-4.5 4.5-6-6V2.5z" stroke="currentColor" />
      <circle cx="5.5" cy="5" r="1" fill="currentColor" />
    </svg>
  );
}

interface CommitContextMenuProps {
  x: number;
  y: number;
  commit: Commit;
  onClose: () => void;
  onCreateBranch?: (hash: string, defaultName: string) => void;
}

export function CommitContextMenu({
  x,
  y,
  commit,
  onClose,
  onCreateBranch,
}: CommitContextMenuProps) {
  const currentBranch = usePanelStore((s) => s.currentBranch);
  const [isRebasing, setIsRebasing] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [isCherryPicking, setIsCherryPicking] = useState(false);

  // Query rebase/merge/cherry-pick state to determine if Drop Commit should be disabled
  useEffect(() => {
    const fetchRepoState = async () => {
      try {
        const [rebaseState, mergeState, cherryPickState] = await Promise.all([
          bridge.request("getRebaseState") as Promise<{ isRebasing: boolean }>,
          bridge.request("getMergeState") as Promise<{ isMerging: boolean }>,
          bridge.request("getCherryPickState") as Promise<{
            isCherryPicking: boolean;
          }>,
        ]);
        setIsRebasing(rebaseState?.isRebasing ?? false);
        setIsMerging(mergeState?.isMerging ?? false);
        setIsCherryPicking(cherryPickState?.isCherryPicking ?? false);
      } catch {
        // If we can't determine state, leave as not disabled
      }
    };
    fetchRepoState();
  }, []);

  const shortHash = commit.shortHash || commit.hash.slice(0, 8);

  const handleCopyHash = async () => {
    onClose();
    try {
      await bridge.request("copyToClipboard", { text: commit.hash });
    } catch (err) {
      console.error("Copy failed:", err);
    }
  };

  const handleCherryPick = async () => {
    onClose();
    try {
      await bridgeWithProgress("cherryPick", { hash: commit.hash });
    } catch (err) {
      console.error("Cherry-pick failed:", err);
    }
  };

  const handleCheckoutRevision = async () => {
    onClose();
    try {
      await bridgeWithProgress("checkoutCommit", { hash: commit.hash });
    } catch (err) {
      console.error("Checkout revision failed:", err);
    }
  };

  const handleResetHard = async () => {
    onClose();
    try {
      await bridgeWithProgress("resetToCommit", {
        hash: commit.hash,
        mode: "hard",
      });
    } catch (err) {
      console.error("Reset failed:", err);
    }
  };

  const handleResetMixed = async () => {
    onClose();
    try {
      await bridgeWithProgress("resetToCommit", {
        hash: commit.hash,
        mode: "mixed",
      });
    } catch (err) {
      console.error("Reset failed:", err);
    }
  };

  const handleResetSoft = async () => {
    onClose();
    try {
      await bridgeWithProgress("resetToCommit", {
        hash: commit.hash,
        mode: "soft",
      });
    } catch (err) {
      console.error("Reset failed:", err);
    }
  };

  const handleRevert = async () => {
    onClose();
    try {
      await bridgeWithProgress("revertCommit", { hash: commit.hash });
    } catch (err) {
      console.error("Revert failed:", err);
    }
  };

  const handleDropCommit = async () => {
    onClose();
    try {
      await bridgeWithProgress("dropCommit", { hash: commit.hash });
    } catch (err) {
      console.error("Drop commit failed:", err);
    }
  };

  const handleNewBranch = async () => {
    onClose();
    if (onCreateBranch) {
      onCreateBranch(commit.hash, "");
      return;
    }
    // Fallback to showInputBox if no dialog handler provided
    const result = (await bridge.request("showInputBox", {
      prompt: t("panel.newBranchPrompt", { hash: shortHash }),
      placeHolder: t("panel.branchNamePlaceholder"),
    })) as { value: string | null };
    if (!result.value || !result.value.trim()) return;
    try {
      await bridge.request("createBranchFromCommit", {
        branchName: result.value.trim(),
        hash: commit.hash,
      });
    } catch (err) {
      console.error("Create branch failed:", err);
    }
  };

  const handleNewTag = async () => {
    onClose();
    const result = (await bridge.request("showInputBox", {
      prompt: t("panel.newTagPrompt", { hash: shortHash }),
      placeHolder: t("panel.tagNamePlaceholder"),
    })) as { value: string | null };
    if (!result.value || !result.value.trim()) return;
    try {
      await bridge.request("createTag", {
        tagName: result.value.trim(),
        hash: commit.hash,
      });
    } catch (err) {
      console.error("Create tag failed:", err);
    }
  };

  const filter = usePanelStore((s) => s.filter);
  const selectCommit = usePanelStore((s) => s.selectCommit);

  const handleShowInGitLog = () => {
    onClose();
    // Clear file filter and select this commit in the full log
    usePanelStore.getState().setFilter({ file: "" });
    // After refresh, select this commit
    setTimeout(() => {
      selectCommit(commit.hash);
    }, 500);
  };

  // Drop Commit is disabled when in detached HEAD, rebasing, merging, or cherry-picking
  const isDropCommitDisabled =
    !currentBranch || isRebasing || isMerging || isCherryPicking;

  const items: {
    id?: string;
    capability?: VcsAction["capability"];
    label: string;
    action: () => void;
    separator?: boolean;
    icon?: React.ReactNode;
    disabled?: boolean;
  }[] = [
    {
      id: "copyRevision",
      capability: "copyRevision",
      label: t("panel.copyRevisionNumber"),
      action: handleCopyHash,
      icon: <IconCopy />,
    },
    {
      id: "cherryPick",
      capability: "cherryPick",
      label: t("panel.cherryPick"),
      action: handleCherryPick,
      icon: <IconCherryPick />,
    },
    { label: "", action: () => {}, separator: true },
    {
      id: "checkoutRevision",
      capability: "checkoutRevision",
      label: t("panel.checkoutRevision"),
      action: handleCheckoutRevision,
    },
    { label: "", action: () => {}, separator: true },
    {
      id: "resetMixed",
      label: t("panel.resetMixed"),
      action: handleResetMixed,
      icon: <IconRevert />,
    },
    {
      id: "resetSoft",
      label: t("panel.resetSoft"),
      action: handleResetSoft,
      icon: <IconRevert />,
    },
    {
      id: "resetHard",
      label: t("panel.resetHard"),
      action: handleResetHard,
      icon: <IconRevert />,
    },
    {
      id: "revertCommit",
      label: t("panel.revertCommit"),
      action: handleRevert,
      icon: <IconRevert />,
    },
    {
      id: "dropCommit",
      label: t("panel.dropCommit"),
      action: handleDropCommit,
      icon: <IconRevert />,
      disabled: isDropCommitDisabled,
    },
    { label: "", action: () => {}, separator: true },
    {
      id: "newBranch",
      capability: "createBranch",
      label: t("panel.newBranch"),
      action: handleNewBranch,
      icon: <IconBranch />,
    },
    {
      id: "newTag",
      label: t("panel.newTag"),
      action: handleNewTag,
      icon: <IconTag />,
    },
  ];

  // Add "Show in Git Log" when file filter is active
  if (filter.file) {
    items.push({ label: "", action: () => {}, separator: true });
    items.push({
      id: "showInGitLog",
      label: t("panel.showInGitLog"),
      action: handleShowInGitLog,
      icon: <IconBranch />,
    });
  }

  const actions = new Map<string, () => void>();
  const menuItems: VcsAction[] = [];
  let separatorBefore = false;
  for (const item of items) {
    if (item.separator) {
      separatorBefore = true;
      continue;
    }
    if (!item.id) continue;
    actions.set(item.id, item.action);
    menuItems.push({
      id: item.id,
      label: item.label,
      capability: item.capability,
      disabled: item.disabled,
      icon: item.icon,
      separatorBefore,
    });
    separatorBefore = false;
  }
  return (
    <VcsContextMenu
      position={{ x, y }}
      items={menuItems}
      capabilities={GIT_UI_CAPABILITIES}
      onSelect={(id) => actions.get(id)?.()}
      onClose={onClose}
    />
  );
}
