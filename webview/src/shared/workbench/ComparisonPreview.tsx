import { structuredPatch } from "diff";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  type VcsDiffComparison,
  type VcsDiffHunk,
  VcsDiffPreview,
} from "../../../../packages/vcs-ui/src";
import { useShiki } from "../hooks/useShiki";
import { t } from "../i18n";
import {
  type ComparisonSelection,
  type DiffState,
  readDiffState,
  workbenchRequest,
} from "./transport";

type Content =
  | { available: true; text: string }
  | {
      available: false;
      reason: "binary" | "tooLarge" | "tooManyLines" | "undecodable";
    };
type Side = {
  source: "git" | "cvs" | "empty" | "worktree";
  path: string;
  revision?: string;
  label?: string;
};
export interface ComparisonResult {
  kind: "git" | "cvs";
  source: "working" | "history";
  filePath: string;
  title: string;
  left: Side;
  right: Side;
  leftContent: Content;
  rightContent: Content;
  unsaved?: boolean;
}
function sideLabel(side: Side): string {
  return side.source === "empty"
    ? t("diff.emptySide")
    : side.source === "worktree"
      ? t("diff.workingCopy")
      : side.revision === ":0"
        ? t("diff.index")
        : (side.revision ?? side.label ?? "");
}
export function previewModel(
  data: ComparisonResult,
  selection: ComparisonSelection,
  id: string,
): VcsDiffComparison {
  const result: VcsDiffComparison = {
    id,
    source: t(
      selection.source === "history"
        ? "diff.historySource"
        : selection.source === "staged"
          ? "diff.stagedSource"
          : "diff.workingSource",
    ),
    title: data.filePath,
    left: {
      label: sideLabel(data.left),
      path: data.left.path,
      version: data.left.revision,
    },
    right: {
      label: sideLabel(data.right),
      path: data.right.path,
      version: data.right.revision,
    },
    unsavedWarning: data.unsaved ? t("diff.unsaved") : undefined,
  };
  for (const content of [data.leftContent, data.rightContent]) {
    if (!content.available) {
      result.unavailableReason = t(`diff.${content.reason}`);
      return result;
    }
  }
  const left = data.leftContent as Extract<Content, { available: true }>;
  const right = data.rightContent as Extract<Content, { available: true }>;
  const patch = structuredPatch(
    data.left.path,
    data.right.path,
    left.text,
    right.text,
    undefined,
    undefined,
    { context: 3, timeout: 150 },
  );
  if (!patch) {
    result.unavailableReason = t("diff.complex");
    return result;
  }
  result.hunks = patch.hunks.map((hunk, index) => {
    let leftLine = hunk.oldStart,
      rightLine = hunk.newStart;
    const lines: VcsDiffHunk["lines"][number][] = [];
    for (const line of hunk.lines) {
      if (line.startsWith("\\")) continue;
      if (line.startsWith("-"))
        lines.push({
          left: line.slice(1),
          leftLine: leftLine++,
          kind: "removed",
        });
      else if (line.startsWith("+"))
        lines.push({
          right: line.slice(1),
          rightLine: rightLine++,
          kind: "added",
        });
      else
        lines.push({
          left: line.slice(1),
          right: line.slice(1),
          leftLine: leftLine++,
          rightLine: rightLine++,
          kind: "context",
        });
    }
    return {
      id: String(index),
      title: `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`,
      lines,
    };
  });
  if (!result.hunks.length) result.unavailableReason = t("diff.identical");
  return result;
}
/** Selection is durable; response bodies and Git drafts only live in this page. */
export function ComparisonPreview({
  state: input,
  onChange,
}: {
  state?: DiffState;
  onChange: (state: DiffState) => void;
}) {
  const state = readDiffState(input);
  const [result, setResult] = useState<ComparisonResult>();
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const latest = useRef(state);
  latest.current = state;
  const write = useRef(onChange);
  write.current = onChange;
  const request = useRef(0);
  const mounted = useRef(true);
  const choose = useCallback(
    (selection: ComparisonSelection, persist = true) => {
      if (persist) {
        const next = { ...latest.current, selection };
        latest.current = next;
        write.current(next);
      }
      const id = ++request.current;
      setLoading(true);
      setError("");
      if (persist) setResult(undefined);
      void workbenchRequest<ComparisonResult>("jettortoiseComparison", {
        action: "preview",
        selection,
      })
        .then((data) => {
          if (mounted.current && id === request.current) setResult(data);
        })
        .catch((error: Error) => {
          if (mounted.current && id === request.current)
            setError(error.message);
        })
        .finally(() => {
          if (mounted.current && id === request.current) setLoading(false);
        });
    },
    [],
  );
  useEffect(() => {
    mounted.current = true;
    let refreshTimer: ReturnType<typeof setTimeout> | undefined;
    const select = (event: Event) =>
      choose((event as CustomEvent<ComparisonSelection>).detail);
    const refresh = (event: MessageEvent) => {
      const data = event.data;
      if (
        data?.type === "state" ||
        (data?.type === "event" &&
          ["gitStateChanged", "commitStateChanged"].includes(data.event))
      ) {
        clearTimeout(refreshTimer);
        refreshTimer = setTimeout(() => {
          if (latest.current.selection) choose(latest.current.selection, false);
        }, 200);
      }
    };
    window.addEventListener("jettortoise-select-comparison", select);
    window.addEventListener("message", refresh);
    if (latest.current.selection) choose(latest.current.selection, false);
    return () => {
      mounted.current = false;
      request.current++;
      clearTimeout(refreshTimer);
      window.removeEventListener("jettortoise-select-comparison", select);
      window.removeEventListener("message", refresh);
    };
  }, [choose]);
  const model = useMemo(
    () =>
      result && state.selection
        ? previewModel(result, state.selection, String(request.current))
        : undefined,
    [result, state.selection],
  );
  const highlighter = useShiki();
  const nativeAction = (action: "native" | "file") => {
    if (latest.current.selection)
      void workbenchRequest("jettortoiseComparison", {
        action,
        selection: latest.current.selection,
      }).catch((error: Error) => setError(error.message));
  };
  return (
    <div className="vcs-ui-comparison-host">
      {error && (
        <p role="alert">
          {error}{" "}
          <button type="button" onClick={() => nativeAction("native")}>
            {t("diff.openNative")}
          </button>
        </p>
      )}
      {loading && <p role="status">{t("common.loading")}</p>}
      <VcsDiffPreview
        comparison={model}
        mode={state.mode}
        onModeChange={(mode) => write.current({ ...latest.current, mode })}
        onOpenNative={() => nativeAction("native")}
        onOpenFile={() => nativeAction("file")}
        labels={{
          split: t("diff.split"),
          inline: t("diff.inline"),
          previousChange: t("diff.previous"),
          nextChange: t("diff.next"),
          openNative: t("diff.openNative"),
          openFile: t("diff.openFile"),
          noPreview: t("diff.selectFile"),
        }}
        renderLine={(line) => {
          const extension = result?.filePath.split(".").pop() ?? "";
          const language = (
            {
              ts: "typescript",
              tsx: "typescript",
              js: "javascript",
              jsx: "javascript",
              json: "json",
              css: "css",
              html: "html",
              md: "markdown",
            } as const
          )[extension as "ts"];
          if (!highlighter || !language || line.length > 2000) return line;
          try {
            return (
              highlighter
                .codeToTokens(line, {
                  lang: language,
                  theme: document.body.classList.contains("vscode-light")
                    ? "github-light"
                    : "github-dark",
                })
                .tokens[0]?.map((token, index) => (
                  <span
                    key={`${index}-${token.offset}`}
                    style={{ color: token.color }}
                  >
                    {token.content}
                  </span>
                )) ?? line
            );
          } catch {
            return line;
          }
        }}
      />
    </div>
  );
}
