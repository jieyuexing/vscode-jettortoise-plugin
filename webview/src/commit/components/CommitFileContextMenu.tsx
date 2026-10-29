import { useEffect, useRef } from "react";
import { bridge } from "../../shared/bridge";
import type { ChangeFile } from "../../shared/models/changes";
import { useCommitStore } from "../../shared/store/commit-store";
import { useRepositoryStore } from "../../shared/store/repository-store";
export function CommitFileContextMenu({
  x,
  y,
  file,
  onClose,
}: {
  x: number;
  y: number;
  file: ChangeFile;
  onClose: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const repository = useRepositoryStore((state) =>
    state.repositories.find((item) => item.id === file.repositoryId),
  );
  useEffect(() => {
    const close = (event: MouseEvent) => {
      if (!ref.current?.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", close);
    document.addEventListener("keydown", key);
    window.addEventListener("blur", onClose);
    return () => {
      document.removeEventListener("mousedown", close);
      document.removeEventListener("keydown", key);
      window.removeEventListener("blur", onClose);
    };
  }, [onClose]);
  const invoke = async (
    command: string,
    params: Record<string, unknown> = {},
  ) => {
    onClose();
    try {
      await bridge.request(command, {
        repositoryId: file.repositoryId,
        ...params,
      });
      await useCommitStore.getState().fetchChanges();
    } catch (error) {
      useCommitStore.setState({
        error: error instanceof Error ? error.message : "Operation failed.",
      });
    }
  };
  return (
    <div
      ref={ref}
      role="menu"
      className="commit-context-menu"
      style={{
        position: "fixed",
        left: Math.max(0, Math.min(x, window.innerWidth - 220)),
        top: Math.max(0, Math.min(y, window.innerHeight - 220)),
        zIndex: 1000,
      }}
    >
      {!file.directory && (
        <button
          type="button"
          role="menuitem"
          className="commit-context-menu-item"
          onClick={() => void invoke("openFile", { filePath: file.path })}
        >
          Open File
        </button>
      )}
      {file.status === "untracked" ? (
        <>
          <button
            type="button"
            role="menuitem"
            className="commit-context-menu-item"
            onClick={() =>
              void invoke("ignoreUnversioned", { filePaths: [file.path] })
            }
          >
            Add to {repository?.kind === "cvs" ? ".cvsignore" : ".gitignore"}
          </button>
          {!file.directory && (
            <button
              type="button"
              role="menuitem"
              className="commit-context-menu-item"
              onClick={() =>
                void invoke("addUnversioned", { filePaths: [file.path] })
              }
            >
              Add to Version Control
            </button>
          )}
        </>
      ) : (
        <>
          {!file.directory && (
            <button
              type="button"
              role="menuitem"
              className="commit-context-menu-item"
              onClick={() =>
                void invoke("showDiffForWorkingFile", {
                  filePath: file.path,
                  staged: file.staged,
                })
              }
            >
              Show Diff
            </button>
          )}
          {file.status !== "incoming" && (
            <button
              type="button"
              role="menuitem"
              className="commit-context-menu-item"
              onClick={() =>
                void invoke("openRollbackPanel", {
                  files: [
                    {
                      path: file.path,
                      status: file.status,
                      staged: file.staged,
                    },
                  ],
                })
              }
            >
              Rollback
            </button>
          )}
          {repository?.kind === "git" && (
            <>
              <button
                type="button"
                role="menuitem"
                className="commit-context-menu-item"
                onClick={() =>
                  void invoke(file.staged ? "unstageFile" : "stageFile", {
                    filePath: file.path,
                  })
                }
              >
                {file.staged ? "Unstage" : "Stage"}
              </button>
              <button
                type="button"
                role="menuitem"
                className="commit-context-menu-item"
                onClick={() =>
                  void invoke("ideaShelveChanges", {
                    message: "Shelved changes",
                    filePaths: [file.path],
                  })
                }
              >
                Shelve (Git)
              </button>
            </>
          )}
        </>
      )}
    </div>
  );
}
