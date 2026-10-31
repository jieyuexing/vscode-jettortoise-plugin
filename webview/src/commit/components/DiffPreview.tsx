import { diffLines } from "diff";
import { useEffect, useMemo, useRef, useState } from "react";
import type { MaterializedComparison } from "../../../../src/comparison/types";
import { calculateInlineDiffs } from "../../conflicts/utils/inline-diff";
import { bridge } from "../../shared/bridge";
import { t } from "../../shared/i18n";
import { type ChangeFile, fileKey } from "../../shared/models/changes";
import { useRepositoryStore } from "../../shared/store/repository-store";
import { changeAction, showWorkingDiff } from "./ChangeTree";
import { Icon } from "./Toolbar";

interface DiffRow {
  left?: string;
  right?: string;
  leftLine?: number;
  rightLine?: number;
  changed: boolean;
}
export function previewRows(
  left: string,
  right: string,
): DiffRow[] | undefined {
  if (left.split("\n").length + right.split("\n").length > 8000)
    return undefined;
  const chunks = diffLines(left, right, { timeout: 150, maxEditLength: 2000 });
  if (!chunks) return undefined;
  const rows: DiffRow[] = [];
  let leftLine = 1,
    rightLine = 1;
  const lines = (value: string) => value.replace(/\n$/, "").split("\n");
  for (let index = 0; index < chunks.length; index++) {
    const chunk = chunks[index];
    if (!chunk.added && !chunk.removed) {
      for (const text of lines(chunk.value))
        rows.push({
          left: text,
          right: text,
          leftLine: leftLine++,
          rightLine: rightLine++,
          changed: false,
        });
    } else {
      const removed = chunk.removed ? lines(chunk.value) : [];
      const added = chunk.added
        ? lines(chunk.value)
        : chunks[index + 1]?.added
          ? lines(chunks[++index].value)
          : [];
      for (let row = 0; row < Math.max(removed.length, added.length); row++) {
        rows.push({
          left: removed[row],
          right: added[row],
          leftLine: row < removed.length ? leftLine++ : undefined,
          rightLine: row < added.length ? rightLine++ : undefined,
          changed: true,
        });
      }
    }
  }
  return rows;
}

function DiffText({
  text,
  other,
  side,
}: {
  text?: string;
  other?: string;
  side: "left" | "right";
}) {
  if (text === undefined) return null;
  if (other === undefined || text.length + other.length > 4000)
    return <>{text}</>;
  const tokens =
    calculateInlineDiffs(
      side === "left" ? text : other,
      side === "left" ? other : text,
    )[0] ?? [];
  return (
    <>
      {tokens
        .filter((token) => (side === "left" ? !token.added : !token.removed))
        .map((token, index) => (
          <span
            key={index}
            className={
              token.added
                ? "diff-word-added"
                : token.removed
                  ? "diff-word-removed"
                  : undefined
            }
          >
            {token.value}
          </span>
        ))}
    </>
  );
}

export function DiffPreview({
  file,
  files,
  onSelect,
}: {
  file?: ChangeFile;
  files: ChangeFile[];
  onSelect: (file: ChangeFile) => void;
}) {
  const [result, setResult] = useState<MaterializedComparison>();
  const [error, setError] = useState<string>();
  const [loading, setLoading] = useState(false);
  const [unified, setUnified] = useState(false);
  const [hunk, setHunk] = useState(-1);
  const body = useRef<HTMLDivElement>(null);
  const { repositories } = useRepositoryStore();
  useEffect(() => {
    let active = true;
    setResult(undefined);
    setError(undefined);
    setHunk(-1);
    setLoading(!!file);
    if (file)
      bridge
        .request("getWorkingFilePreview", {
          repositoryId: file.repositoryId,
          filePath: file.path,
          staged: file.staged,
        })
        .then((value) => {
          if (active) setResult(value as MaterializedComparison);
        })
        .catch((error) => {
          if (active)
            setError(
              error instanceof Error ? error.message : t("Operation failed."),
            );
        })
        .finally(() => {
          if (active) setLoading(false);
        });
    return () => {
      active = false;
    };
  }, [file]);
  const rows = useMemo(
    () =>
      result?.leftContent.available && result.rightContent.available
        ? previewRows(result.leftContent.text, result.rightContent.text)
        : undefined,
    [result],
  );
  const hunks = useMemo(
    () =>
      rows?.flatMap((row, index) =>
        row.changed && !rows[index - 1]?.changed ? [index] : [],
      ) ?? [],
    [rows],
  );
  const index = files.findIndex(
    (item) => file && fileKey(item) === fileKey(file),
  );
  const leftLabel =
    result?.left.source === "git" && result.left.revision === "HEAD"
      ? "HEAD"
      : result?.kind === "cvs"
        ? `BASE (${result.left.revision ?? "0"})`
        : (result?.left.revision ?? t("Base"));
  const repository = repositories.find(
    (repo) => repo.id === file?.repositoryId,
  );
  const move = (direction: number) => {
    const next = Math.max(0, Math.min(hunks.length - 1, hunk + direction));
    setHunk(next);
    body.current
      ?.querySelector(`[data-diff-row="${hunks[next]}"]`)
      ?.scrollIntoView({ block: "center" });
  };
  let notice: string | undefined;
  if (!file) notice = t("Select a file to preview its changes.");
  else if (loading) notice = t("Loading diff…");
  else if (error) notice = error;
  else if (
    result &&
    (!result.leftContent.available || !result.rightContent.available)
  )
    notice = t(
      "Preview unavailable for binary, non-UTF-8 or large files. Double-click to open in the editor.",
    );
  else if (result && !rows)
    notice = t(
      "Diff is too complex to preview. Double-click to open in the editor.",
    );
  const cell = (row: DiffRow, side: "left" | "right") => {
    const text = row[side];
    const other = row[side === "left" ? "right" : "left"];
    const kind = row.changed
      ? text === undefined
        ? "gap"
        : other !== undefined
          ? "modified"
          : side === "right"
            ? "added"
            : "removed"
      : "";
    return (
      <div className={`diff-cell ${kind}`}>
        <span className="diff-line-number">
          {side === "left" ? row.leftLine : row.rightLine}
        </span>
        <code>
          <DiffText
            text={text}
            other={row.changed ? other : undefined}
            side={side}
          />
        </code>
      </div>
    );
  };
  return (
    <section className="diff-preview" aria-label={t("Diff Preview")}>
      <div className="diff-preview-toolbar">
        <button
          type="button"
          title={t("Previous Difference")}
          aria-label={t("Previous Difference")}
          disabled={!hunks.length || hunk <= 0}
          onClick={() => move(-1)}
        >
          <Arrow direction="up" />
        </button>
        <button
          type="button"
          title={t("Next Difference")}
          aria-label={t("Next Difference")}
          disabled={!hunks.length || hunk >= hunks.length - 1}
          onClick={() => move(1)}
        >
          <Arrow direction="down" />
        </button>
        <div className="diff-file-navigation">
          <button
            type="button"
            aria-label={t("Previous File")}
            disabled={index <= 0}
            onClick={() => onSelect(files[index - 1])}
          >
            <Arrow direction="left" />
          </button>
          <span>
            {t("{0}/{1} files", Math.max(0, index + 1), files.length)}
          </span>
          <button
            type="button"
            aria-label={t("Next File")}
            disabled={index < 0 || index >= files.length - 1}
            onClick={() => onSelect(files[index + 1])}
          >
            <Arrow direction="right" />
          </button>
        </div>
        <span className="diff-toolbar-spacer" />
        <span className="diff-count">{t("{0} differences", hunks.length)}</span>
        <div className="diff-segment">
          <button
            type="button"
            aria-pressed={!unified}
            onClick={() => setUnified(false)}
          >
            {t("Side by Side")}
          </button>
          <button
            type="button"
            aria-pressed={unified}
            onClick={() => setUnified(true)}
          >
            {t("Unified")}
          </button>
        </div>
      </div>
      {file && (
        <div className="diff-preview-path" title={file.path}>
          <b>{file.path.split("/").pop()}</b>
          <span>
            {repository?.name} · {leftLabel} ↔ {t("Working Tree")}
          </span>
        </div>
      )}
      {notice ? (
        <div className="diff-preview-notice" role={error ? "alert" : "status"}>
          {notice}
        </div>
      ) : (
        <>
          {!unified && (
            <div className="diff-column-headings">
              <span>{leftLabel}</span>
              <span className="diff-gutter" />
              <span>{t("Working Tree")}</span>
            </div>
          )}
          <div
            ref={body}
            className={`diff-preview-body ${unified ? "unified" : "split"}`}
            tabIndex={0}
          >
            <div className="diff-preview-lines">
              {rows?.map((row, rowIndex) => (
                <div
                  key={rowIndex}
                  data-diff-row={rowIndex}
                  className="diff-row"
                >
                  {unified ? (
                    <>
                      {row.changed &&
                        row.left !== undefined &&
                        cell(row, "left")}
                      {row.right !== undefined && cell(row, "right")}
                    </>
                  ) : (
                    <>
                      {cell(row, "left")}
                      <div className="diff-gutter">
                        {row.changed && !rows[rowIndex - 1]?.changed && (
                          <button
                            type="button"
                            title={t("Rollback this change in the full diff")}
                            aria-label={t(
                              "Rollback this change in the full diff",
                            )}
                            onClick={() =>
                              file &&
                              void changeAction(() => showWorkingDiff(file))
                            }
                          >
                            <Icon path="M6 4 2 8l4 4M2 8h8a3 3 0 0 1 0 6" />
                          </button>
                        )}
                      </div>
                      {cell(row, "right")}
                    </>
                  )}
                </div>
              ))}
            </div>
          </div>
        </>
      )}
    </section>
  );
}
function Arrow({ direction }: { direction: "up" | "down" | "left" | "right" }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 16 16"
      fill="none"
      style={{
        transform: `rotate(${{ up: 0, right: 90, down: 180, left: 270 }[direction]}deg)`,
      }}
      aria-hidden="true"
    >
      <path
        d="M8 13V3M4 7l4-4 4 4"
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  );
}
