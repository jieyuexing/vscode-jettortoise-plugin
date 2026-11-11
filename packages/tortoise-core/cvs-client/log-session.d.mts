export interface LogRevision {
  path: string;
  revision: string;
  time: number;
  author: string;
  state: string;
  message: string;
  commitId?: string;
}
/** 仓库日志缓存：已覆盖的起点（0 为全部历史）、最新修订时间、最近一次连服务器的时间与修订。 */
export interface LogState {
  coveredFrom: number;
  newest: number | null;
  fetchedAt: number;
  revisions: LogRevision[];
}
export interface LogOptions {
  refresh?: boolean;
  stale?: boolean;
  now: number;
}
export const DAY: number;
export function newestTime(revisions: LogRevision[]): number | null;
export function rangeStart(days: number, now: number): number;
export function covers(state: LogState, needFrom: number): boolean;
export function isStale(state: LogState, options: LogOptions): boolean;
export function needsFetch(
  state: LogState | undefined,
  options: LogOptions & { days: number },
): boolean;
export function loadRepositoryLog(input: {
  state?: LogState;
  days: number;
  refresh?: boolean;
  stale?: boolean;
  now?: () => number;
  fetchRevisions(
    range: { from?: number; to?: number },
    signal?: AbortSignal,
  ): Promise<LogRevision[]>;
  readLog?(): Promise<LogState | undefined>;
  writeLog?(state: LogState): Promise<void>;
  signal?: AbortSignal;
}): Promise<{
  state: LogState;
  contacted: boolean;
  refreshed: boolean;
  error?: unknown;
}>;
