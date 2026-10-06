import {
  RevisionInfo,
  type VcsRevision,
} from "../../../../packages/vcs-ui/src";
import { t } from "../i18n";
import type { Commit } from "../types/git";

function formatDateTime(dateString: string): string {
  const date = new Date(dateString);
  if (Number.isNaN(date.getTime())) return dateString;
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  const hour = String(date.getHours()).padStart(2, "0");
  const minute = String(date.getMinutes()).padStart(2, "0");
  return `${year}-${month}-${day} ${hour}:${minute}`;
}

function toRevision(commit: Commit): VcsRevision {
  return {
    revisionId: commit.hash,
    shortRevisionId: commit.shortHash,
    subject: commit.subject,
    body: commit.body,
    author: { name: commit.authorName, email: commit.authorEmail },
    timestamp: commit.authorDate,
    references: commit.refs.map((reference) => ({
      name: reference.name,
      kind:
        reference.type === "remote-branch"
          ? "remote"
          : reference.type === "HEAD"
            ? "head"
            : reference.type,
    })),
  };
}

/** Git adapter for the source-owned VCS-neutral revision details. */
export function CommitInfo({ commit }: { commit: Commit }) {
  return (
    <RevisionInfo
      revision={toRevision(commit)}
      formatDate={formatDateTime}
      formatAuthoredOn={(date) => t("common.authoredOn", { date })}
    />
  );
}
