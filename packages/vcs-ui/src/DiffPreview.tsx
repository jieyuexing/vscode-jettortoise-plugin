import { useVirtualizer } from "@tanstack/react-virtual";
import { type ReactNode, type RefObject, useEffect, useMemo, useRef, useState } from "react";

export type VcsDiffMode = "split" | "inline";
export type VcsDiffLineKind = "context" | "added" | "removed" | "changed";

export interface VcsDiffLine {
  left?: string;
  right?: string;
  leftLine?: number;
  rightLine?: number;
  kind?: VcsDiffLineKind;
}

export interface VcsDiffHunk {
  id: string;
  title?: string;
  lines: readonly VcsDiffLine[];
}

export interface VcsDiffSide {
  label: string;
  path?: string;
  version?: string;
  /** Bounded decoded text supplied by the host. It is never rendered as HTML. */
  text?: string;
}

export interface VcsDiffComparison {
  id: string;
  source: string;
  title?: string;
  left: VcsDiffSide;
  right: VcsDiffSide;
  hunks?: readonly VcsDiffHunk[];
  unavailableReason?: string;
  unsavedWarning?: string;
}

export interface VcsDiffPreviewLabels {
  split: string;
  inline: string;
  previousChange: string;
  nextChange: string;
  openNative: string;
  openFile: string;
  noPreview: string;
}

export interface VcsDiffPreviewProps {
  comparison?: VcsDiffComparison | null;
  labels: VcsDiffPreviewLabels;
  mode?: VcsDiffMode;
  onModeChange?: (mode: VcsDiffMode) => void;
  onOpenNative?: () => void;
  onOpenFile?: () => void;
  /** A consumer may supply syntax-safe React nodes for a line. */
  renderLine?: (line: string, side: "left" | "right") => ReactNode;
}

// Up to 20,000 lines per side plus hunk headers, rendered through virtualization.
const MAX_RENDERED_LINES = 60_000;

/**
 * Read-only diff surface. The extension owns comparison calculation and size
 * limits; this component only renders already bounded text using React nodes.
 */
export function VcsDiffPreview({
  comparison,
  labels,
  mode = "split",
  onModeChange,
  onOpenNative,
  onOpenFile,
  renderLine,
}: VcsDiffPreviewProps) {
  const hunks = useMemo(() => comparison ? (comparison.hunks?.length ? comparison.hunks : fallbackHunks(comparison)) : [], [comparison]);
  const [activeHunk, setActiveHunk] = useState(0);
  const leftScroll = useRef<HTMLDivElement>(null);
  const rightScroll = useRef<HTMLDivElement>(null);
  const inlineScroll = useRef<HTMLDivElement>(null);
  const leftJump = useRef<(index: number) => void>(() => {});
  const rightJump = useRef<(index: number) => void>(() => {});
  const inlineJump = useRef<(index: number) => void>(() => {});
  const syncing = useRef(false);
  useEffect(() => {
    setActiveHunk(0);
  }, [comparison?.id]);
  const move = (delta: number) => {
    if (!hunks.length) return;
    const next = (activeHunk + delta + hunks.length) % hunks.length;
    setActiveHunk(next);
    const row = flattened.findIndex((entry) => entry.hunk === next);
    if (row >= 0) {
      leftJump.current(row);
      rightJump.current(row);
      inlineJump.current(row);
    }
  };
  const sync = (from: "left" | "right") => {
    if (syncing.current) return;
    const source = from === "left" ? leftScroll.current : rightScroll.current;
    const target = from === "left" ? rightScroll.current : leftScroll.current;
    if (!source || !target) return;
    syncing.current = true;
    target.scrollTop = source.scrollTop;
    requestAnimationFrame(() => { syncing.current = false; });
  };
  // Keep hooks unconditional: preview selection legitimately changes from empty
  // to populated after an async Host response.
  const flattened = useMemo(() => flattenLines(hunks).slice(0, MAX_RENDERED_LINES), [hunks]);
  if (!comparison) return <div className="vcs-ui-diff-empty">{labels.noPreview}</div>;
  if (comparison.unavailableReason) return <div className="vcs-ui-diff-empty" role="status">{comparison.unavailableReason}</div>;
  const line = (value: string | undefined, side: "left" | "right") => renderLine?.(value ?? "", side) ?? value ?? "";
  return (
    <section className="vcs-ui-diff-preview" aria-label={comparison.title || comparison.source}>
      <header className="vcs-ui-diff-header">
        <div className="vcs-ui-diff-title"><strong>{comparison.title || comparison.source}</strong><span>{comparison.source}</span></div>
        <div className="vcs-ui-diff-actions">
          <button type="button" className={mode === "split" ? "active" : ""} onClick={() => onModeChange?.("split")}>{labels.split}</button>
          <button type="button" className={mode === "inline" ? "active" : ""} onClick={() => onModeChange?.("inline")}>{labels.inline}</button>
          <button type="button" className="panel-toggle-btn" aria-label={labels.previousChange} onClick={() => move(-1)}>↑</button>
          <button type="button" className="panel-toggle-btn" aria-label={labels.nextChange} onClick={() => move(1)}>↓</button>
          <button type="button" className="panel-toggle-btn" aria-label={labels.openNative} onClick={onOpenNative}>↗</button>
          <button type="button" className="panel-toggle-btn" aria-label={labels.openFile} onClick={onOpenFile}>□</button>
        </div>
      </header>
      {comparison.unsavedWarning && <div className="vcs-ui-diff-warning" role="status">{comparison.unsavedWarning}</div>}
      {mode === "split" ? (
        <div className="vcs-ui-diff-split">
          <div className="vcs-ui-diff-side-label">{comparison.left.label}</div>
          <div className="vcs-ui-diff-side-label">{comparison.right.label}</div>
          <div className="vcs-ui-diff-scroll" ref={leftScroll} onScroll={() => sync("left")}>
            <VirtualLines rows={flattened} side="left" render={line} activeHunk={activeHunk} scrollRef={leftScroll} onJump={(jump) => { leftJump.current = jump; }} />
          </div>
          <div className="vcs-ui-diff-scroll" ref={rightScroll} onScroll={() => sync("right")}>
            <VirtualLines rows={flattened} side="right" render={line} activeHunk={activeHunk} scrollRef={rightScroll} onJump={(jump) => { rightJump.current = jump; }} />
          </div>
        </div>
      ) : (
        <div className="vcs-ui-diff-inline" ref={inlineScroll}>
          <VirtualLines rows={flattened} side="inline" render={line} activeHunk={activeHunk} scrollRef={inlineScroll} onJump={(jump) => { inlineJump.current = jump; }} />
        </div>
      )}
    </section>
  );
}

function VirtualLines({
  rows,
  side,
  render,
  activeHunk,
  scrollRef,
  onJump,
}: {
  rows: readonly { hunk: number; line: VcsDiffLine }[];
  side: "left" | "right" | "inline";
  render: (value: string | undefined, side: "left" | "right") => ReactNode;
  activeHunk: number;
  scrollRef: RefObject<HTMLDivElement | null>;
  onJump: (jump: (index: number) => void) => void;
}) {
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 18,
    overscan: 20,
    initialRect: { width: 0, height: 360 },
  });
  useEffect(() => onJump((index) => virtualizer.scrollToIndex(index, { align: "center" })), [onJump, virtualizer]);
  return (
    <div style={{ height: virtualizer.getTotalSize(), position: "relative" }}>
      {virtualizer.getVirtualItems().map((virtualRow) => {
        const entry = rows[virtualRow.index];
        return (
          <div key={virtualRow.key} style={{ position: "absolute", top: 0, left: 0, width: "100%", transform: `translateY(${virtualRow.start}px)` }}>
            {side === "inline"
              ? <InlineLine line={entry.line} render={render} />
              : <DiffLine side={side} line={entry.line} render={render} marker={entry.hunk === activeHunk} />}
          </div>
        );
      })}
    </div>
  );
}

function DiffLine({ side, line, render, marker }: { side: "left" | "right"; line: VcsDiffLine; render: (value: string | undefined, side: "left" | "right") => ReactNode; marker: boolean }) {
  const number = side === "left" ? line.leftLine : line.rightLine;
  const value = side === "left" ? line.left : line.right;
  const changed = line.kind && line.kind !== "context";
  return <div className={`vcs-ui-diff-line ${line.kind || "context"}${marker && changed ? " hunk-active" : ""}`}><span className="vcs-ui-diff-number">{number ?? ""}</span><code>{render(value, side)}</code></div>;
}

function InlineLine({ line, render }: { line: VcsDiffLine; render: (value: string | undefined, side: "left" | "right") => ReactNode }) {
  if (line.kind === "removed") return <DiffLine side="left" line={line} render={render} marker={false} />;
  if (line.kind === "added") return <DiffLine side="right" line={line} render={render} marker={false} />;
  return <DiffLine side="right" line={line} render={render} marker={false} />;
}

function flattenLines(hunks: readonly VcsDiffHunk[]) {
  return hunks.flatMap((hunk, hunkIndex) => hunk.lines.map((line) => ({ hunk: hunkIndex, line })));
}

function fallbackHunks(comparison: VcsDiffComparison): VcsDiffHunk[] {
  const left = (comparison.left.text ?? "").split("\n");
  const right = (comparison.right.text ?? "").split("\n");
  const count = Math.max(left.length, right.length);
  const lines: VcsDiffLine[] = [];
  for (let index = 0; index < count && lines.length < MAX_RENDERED_LINES; index += 1) {
    const before = left[index];
    const after = right[index];
    lines.push({ left: before, right: after, leftLine: before === undefined ? undefined : index + 1, rightLine: after === undefined ? undefined : index + 1, kind: before === after ? "context" : before === undefined ? "added" : after === undefined ? "removed" : "changed" });
  }
  return [{ id: "fallback", lines }];
}
