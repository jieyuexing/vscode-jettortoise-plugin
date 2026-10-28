export interface RepositoryBoundary {
  kind: "git" | "cvs";
  root: string;
}
export class NestedRepositoryError extends Error {
  code: string;
  boundaries: RepositoryBoundary[];
  constructor(boundaries?: RepositoryBoundary[], code?: string);
}
export function within(root: string, target: string): boolean;
export function containingRepositories(
  start: string,
): Promise<RepositoryBoundary[]>;
export function nearestRepositories(
  start: string,
): Promise<RepositoryBoundary[]>;
export function isCvsContinuation(
  parent: string,
  child: string,
): Promise<boolean>;
export function readCvsEntries(directory: string): Promise<string[]>;
export function boundariesForPaths(
  root: string,
  kind: "git" | "cvs",
  paths: string[],
): Promise<RepositoryBoundary[]>;
export function assertOwnedPath(
  root: string,
  kind: "git" | "cvs",
  relative: string,
): Promise<void>;
export function listNestedRepositories(
  root: string,
  kind: "git" | "cvs",
): Promise<RepositoryBoundary[]>;
export function assertNoNestedRepositories(
  root: string,
  kind: "git" | "cvs",
): Promise<void>;

export function setBoundaryDiagnostic(
  listener?: (item: { stage: string; path: string }) => void,
): void;
