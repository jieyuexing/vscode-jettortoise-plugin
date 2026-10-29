import { createHash } from "node:crypto";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  isCvsSameProject,
  nearestRepositories,
  type RepositoryBoundary,
  within,
} from "./boundaries.cjs";
import type { RepositoryDescriptor } from "./types";

export interface RepositoryNavigation {
  children(): RepositoryDescriptor[];
  open(root: string): Promise<void>;
}
export interface RepositoryBoundaryNotice {
  id: string;
  kind: "git" | "cvs";
  path: string;
  added: boolean;
}
export class BoundaryNavigation {
  private readonly targets = new Map<string, RepositoryBoundary>();
  constructor(
    private readonly repository: { root: string },
    private readonly navigation?: RepositoryNavigation,
  ) {}
  async list(
    snapshot: RepositoryBoundary[],
  ): Promise<RepositoryBoundaryNotice[]> {
    const registered = this.navigation?.children() ?? [];
    const candidates = [...snapshot, ...registered];
    this.targets.clear();
    for (const candidate of candidates) {
      const added = registered.some(
        (root) => root.root === candidate.root && root.kind === candidate.kind,
      );
      if (
        candidate.root === this.repository.root ||
        !within(this.repository.root, candidate.root) ||
        (!added &&
          candidate.kind === "cvs" &&
          (await isCvsSameProject(candidate.root, this.repository.root)))
      )
        continue;
      const roots = await nearestRepositories(candidate.root);
      if (
        !roots.some(
          (item) =>
            item.root === candidate.root && item.kind === candidate.kind,
        )
      )
        continue;
      const id = createHash("sha256")
        .update(`${candidate.kind}\0${candidate.root}`)
        .digest("hex");
      this.targets.set(id, candidate);
    }
    return [...this.targets].map(([id, item]) => ({
      id,
      kind: item.kind,
      path: path.relative(this.repository.root, item.root),
      added: registered.some(
        (root) => root.root === item.root && root.kind === item.kind,
      ),
    }));
  }
  async open(id: string): Promise<void> {
    const target = this.targets.get(id);
    if (!target || !this.navigation)
      throw new Error(
        vscode.l10n.t(
          "This nested repository is no longer available. Refresh the panel.",
        ),
      );
    const current = await nearestRepositories(target.root);
    if (
      !current.some(
        (item) => item.root === target.root && item.kind === target.kind,
      )
    )
      throw new Error(
        vscode.l10n.t(
          "This nested repository is no longer available. Refresh the panel.",
        ),
      );
    await this.navigation.open(target.root);
  }
}
export function boundaryErrorText(error: unknown): string | undefined {
  if (!error || typeof error !== "object") return;
  const value = error as { code?: string; boundaries?: RepositoryBoundary[] };
  if (value.code === "NESTED_REPOSITORY")
    return vscode.l10n.t(
      "This operation crosses a nested repository boundary. Open the child repository instead: {0}",
      (value.boundaries ?? []).map((item) => item.root).join(", "),
    );
  if (value.code === "BOUNDARY_UNAVAILABLE")
    return vscode.l10n.t(
      "Repository boundaries could not be fully verified. The operation was not started.",
    );
}
