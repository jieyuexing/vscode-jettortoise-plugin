export type RepositoryKind = "git" | "cvs";
export interface RepositoryInfo {
  id: string;
  kind: RepositoryKind;
  root: string;
  name: string;
}
export interface ChangeFile {
  repositoryId: string;
  path: string;
  oldPath?: string;
  status:
    | "added"
    | "modified"
    | "deleted"
    | "renamed"
    | "untracked"
    | "conflicted"
    | "incoming";
  staged: boolean;
  directory?: boolean;
}
export interface RepositorySnapshot {
  repositoryId: string;
  files: ChangeFile[];
  branch?: string;
  nestedPaths?: string[];
  error?: string;
  refreshing?: boolean;
}
export const fileKey = (file: Pick<ChangeFile, "repositoryId" | "path">) =>
  JSON.stringify([file.repositoryId, file.path]);
export const canCommit = (file: ChangeFile) =>
  !file.directory &&
  !["untracked", "incoming", "conflicted"].includes(file.status);
export function initialSelection(_groups: unknown): Set<string> {
  return new Set();
}
const repositoryOrder = new Intl.Collator(undefined, {
  numeric: true,
  sensitivity: "base",
});
export function compareRepositories(
  a: RepositoryInfo,
  b: RepositoryInfo,
): number {
  return (
    repositoryOrder.compare(a.name, b.name) ||
    a.kind.localeCompare(b.kind) ||
    a.root.localeCompare(b.root)
  );
}
export function groupChanges(
  repositories: RepositoryInfo[],
  snapshots: RepositorySnapshot[],
) {
  return [...repositories].sort(compareRepositories).map((repository) => {
    const snapshot = snapshots.find(
      (item) => item.repositoryId === repository.id,
    );
    const unique = new Map<string, ChangeFile>();
    for (const file of snapshot?.files ?? []) {
      const name = file.path.replace(/\/$/, "");
      if (
        snapshot?.nestedPaths?.some(
          (root) => name === root || name.startsWith(`${root}/`),
        )
      )
        continue;
      const previous = unique.get(name);
      unique.set(name, {
        ...file,
        oldPath: file.oldPath ?? previous?.oldPath,
        repositoryId: repository.id,
      });
    }
    const files = [...unique.values()].sort((a, b) =>
      a.path.localeCompare(b.path),
    );
    const unknownDirectories = files
      .filter((file) => file.status === "untracked" && file.directory)
      .map((file) => file.path.replace(/\/$/, ""));
    const unversioned = files.filter(
      (file) =>
        file.status === "untracked" &&
        !unknownDirectories.some(
          (dir) =>
            file.path !== `${dir}/` &&
            file.path !== dir &&
            file.path.startsWith(`${dir}/`),
        ),
    );
    const changes = files.filter(
      (file) => !["untracked", "incoming"].includes(file.status),
    );
    const incoming = files.filter((file) => file.status === "incoming");
    const rootFiles = changes.filter((file) => !file.path.includes("/"));
    const directories = new Map<string, ChangeFile[]>();
    for (const file of changes) {
      const index = file.path.lastIndexOf("/");
      if (index < 0) continue;
      const directory = file.path.slice(0, index);
      const children = directories.get(directory) ?? [];
      children.push(file);
      directories.set(directory, children);
    }
    return {
      ...repository,
      changes,
      unversioned,
      incoming,
      count: changes.length,
      rootFiles,
      directories: [...directories]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([path, files]) => ({ path, files })),
      error: snapshot?.error,
      refreshing: snapshot?.refreshing,
      unversionedExpanded: false,
      incomingExpanded: false,
    };
  });
}

export interface SnapshotDelta extends Omit<RepositorySnapshot, "files"> {
  changed: ChangeFile[];
  removed: string[];
}
export function snapshotDelta(
  previous: RepositorySnapshot,
  next: RepositorySnapshot,
): SnapshotDelta | undefined {
  const old = new Map(previous.files.map((file) => [fileKey(file), file]));
  const changed: ChangeFile[] = [];
  for (const file of next.files) {
    const key = fileKey(file),
      before = old.get(key);
    if (!before || JSON.stringify(before) !== JSON.stringify(file))
      changed.push(file);
    old.delete(key);
  }
  const { files: _files, ...metadata } = next;
  const removed = [...old.keys()];
  if (
    !changed.length &&
    !removed.length &&
    previous.error === next.error &&
    previous.refreshing === next.refreshing &&
    previous.branch === next.branch &&
    JSON.stringify(previous.nestedPaths) === JSON.stringify(next.nestedPaths)
  )
    return;
  return { ...metadata, changed, removed };
}
export function applySnapshotDelta(
  previous: RepositorySnapshot,
  delta: SnapshotDelta,
): RepositorySnapshot {
  const files = new Map(previous.files.map((file) => [fileKey(file), file]));
  for (const key of delta.removed) files.delete(key);
  for (const file of delta.changed) files.set(fileKey(file), file);
  const { changed: _changed, removed: _removed, ...metadata } = delta;
  return { ...metadata, files: [...files.values()] };
}
