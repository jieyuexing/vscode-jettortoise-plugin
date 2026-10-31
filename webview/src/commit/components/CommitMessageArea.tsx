import { useEffect, useRef } from "react";
import { t } from "../../shared/i18n";
import { canCommit, fileKey } from "../../shared/models/changes";
import { useCommitStore } from "../../shared/store/commit-store";
import { useRepositoryStore } from "../../shared/store/repository-store";

export function CommitMessageArea() {
  const state = useCommitStore();
  const { repositories } = useRepositoryStore();
  const input = useRef<HTMLTextAreaElement>(null);
  const selected = state.changes.filter(
    (file) => canCommit(file) && state.selectedFiles.has(fileKey(file)),
  );
  const roots = new Set(selected.map((file) => file.repositoryId));
  const singleGit =
    roots.size === 1 &&
    repositories.find((repo) => roots.has(repo.id))?.kind === "git";
  const hasGit = repositories.some((repo) => repo.kind === "git");
  useEffect(() => {
    input.current?.focus();
  }, []);
  useEffect(() => {
    if (!singleGit && state.amend) state.setAmend(false);
  }, [singleGit, state.amend, state.setAmend]);
  const disabled =
    !selected.length || !state.commitMessage.trim() || state.loading;
  return (
    <div className="changes-commit">
      <textarea
        ref={input}
        aria-label={t("Commit Message")}
        placeholder={t("Commit message (Ctrl+Enter to commit)")}
        value={state.commitMessage}
        onChange={(event) => state.setCommitMessage(event.target.value)}
        onKeyDown={(event) => {
          if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
            event.preventDefault();
            if (!disabled) void state.commit();
          }
        }}
      />
      <div className="changes-commit-actions">
        <button
          type="button"
          className="primary"
          disabled={disabled}
          onClick={() => void state.commit()}
        >
          {t("Commit")}
        </button>
        {hasGit && (
          <button
            type="button"
            disabled={disabled || !singleGit}
            title={
              !singleGit
                ? t(
                    "Commit and Push is available for one Git repository at a time.",
                  )
                : undefined
            }
            onClick={() => void state.commitAndPush()}
          >
            {t("Commit and Push...")}
          </button>
        )}
        <label>
          <input
            type="checkbox"
            disabled={!singleGit || state.loading}
            checked={state.amend}
            onChange={(event) => state.setAmend(event.target.checked)}
          />
          {t("Amend Last Commit")}
        </label>
        <span className="changes-selection">
          {t(
            "Selected {0} files · {1} repositories",
            selected.length,
            roots.size,
          )}
        </span>
      </div>
    </div>
  );
}
