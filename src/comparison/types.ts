export type ComparisonSource = "git" | "worktree" | "cvs" | "empty";

export interface ComparisonSide {
  source: ComparisonSource;
  /** Repository-relative source path.  It is never a client supplied cwd. */
  path: string;
  /** Git ref or CVS revision; absent for worktree and empty sides. */
  revision?: string;
  /** A stable semantic token; webview/native callers localize display text. */
  label: "head" | "index" | "worktree" | "empty" | "revision";
}

export interface ResolvedComparison {
  kind: "git" | "cvs";
  source: "working" | "history";
  filePath: string;
  title: string;
  left: ComparisonSide;
  right: ComparisonSide;
}

export type ComparisonMaterialization =
  | { available: true; text: string; bytes: number; lines: number }
  | {
      available: false;
      reason: "binary" | "tooLarge" | "tooManyLines" | "undecodable";
    };

export interface MaterializedComparison extends ResolvedComparison {
  leftContent: ComparisonMaterialization;
  rightContent: ComparisonMaterialization;
}
