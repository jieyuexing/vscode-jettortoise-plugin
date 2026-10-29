import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import {
  containingRepositories,
  isCvsSameProject,
  nearestRepositories,
  within,
} from "./boundaries.cjs";
import {
  type DiscoveryOptions,
  type DiscoveryProgress,
  discoverRepositoryRoots,
  readRepositoryReference,
} from "./discovery";
import type {
  LegacyRepositoryRegistrationState,
  RepositoryCatalogEntry,
  RepositoryCatalogSnapshot,
  RepositoryDescriptor,
  RepositoryKind,
  RepositoryOrigin,
  RepositoryRegistrationState,
  RepositorySession,
} from "./types";

export { within } from "./boundaries.cjs";
export function repositoryDescriptor(
  kind: RepositoryKind,
  root: string,
): RepositoryDescriptor {
  return {
    kind,
    root,
    id: createHash("sha256").update(`${kind}\0${root}`).digest("hex"),
    title: `JetTortoise · ${path.basename(root)} [${kind === "git" ? "Git" : "CVS"}] — ${root}`,
    capabilities: Object.freeze(
      kind === "git"
        ? {
            history: true,
            compareRevision: true,
            copyRevision: true,
            commit: true,
            rollback: true,
            update: true,
            checkoutRevision: true,
            createBranch: true,
            deleteBranch: true,
            merge: true,
            shelve: true,
            push: true,
            rebase: true,
            cherryPick: true,
          }
        : {
            history: true,
            compareRevision: true,
            copyRevision: true,
            commit: true,
            rollback: true,
            update: true,
          },
    ),
  };
}
/** Only inspect an explicit path's ancestors. Never register discovered roots. */
export async function discoverRepositories(
  start: string,
): Promise<RepositoryDescriptor[]> {
  return (await containingRepositories(start)).map((item) =>
    repositoryDescriptor(item.kind, item.root),
  );
}
function storedRoot(
  value: unknown,
): { kind: RepositoryKind; root: string; identity?: string } | undefined {
  if (!value || typeof value !== "object") return;
  const item = value as Record<string, unknown>;
  if (
    (item.kind !== "git" && item.kind !== "cvs") ||
    typeof item.root !== "string" ||
    !path.isAbsolute(item.root)
  )
    return;
  return {
    kind: item.kind,
    root: item.root,
    identity: typeof item.identity === "string" ? item.identity : undefined,
  };
}
async function identity(repository: RepositoryDescriptor): Promise<string> {
  const root = await fs.stat(repository.root);
  const marker = path.join(
    repository.root,
    repository.kind === "git" ? ".git" : "CVS",
  );
  const stat = await fs.stat(marker);
  return createHash("sha256")
    .update(
      `${root.dev}:${root.ino}:${stat.dev}:${stat.ino}:${await fs.realpath(marker)}`,
    )
    .update(stat.isFile() ? await fs.readFile(marker) : "")
    .digest("hex");
}
export class RepositoryRegistry implements vscode.Disposable {
  readonly repositories = new Map<string, RepositoryDescriptor>();
  private readonly sessions = new Map<string, RepositorySession>();
  private readonly identities = new Map<string, string>();
  private readonly retained = new Map<string, RepositoryDescriptor>();
  private readonly origins = new Map<string, RepositoryOrigin>();
  private readonly hidden = new Set<string>();
  private readonly unavailable = new Map<string, string>();
  private readonly activity = new Map<
    string,
    RepositoryCatalogEntry["activity"]
  >();
  private readonly identityTails = new Map<string, Promise<void>>();
  private readonly discoveryTasks = new Map<string, Promise<void>>();
  private readonly listeners = new Set<
    (snapshot: RepositoryCatalogSnapshot) => void
  >();
  private scanning = false;
  private scanIncomplete = false;
  private scannedAt: number | undefined;
  private migrationPending = false;
  private saveTail = Promise.resolve();
  private initialization: Promise<void> = Promise.resolve();
  activeId: string | undefined;
  constructor(
    private readonly factory: (
      repository: RepositoryDescriptor,
      ensureAvailable: () => Promise<void>,
      onActive: () => void,
    ) => RepositorySession,
    private readonly storage?: {
      saved: unknown;
      registered?: unknown;
      save: (value: RepositoryRegistrationState) => void | Thenable<void>;
    },
  ) {
    const state = storage?.registered as
      | Partial<RepositoryRegistrationState | LegacyRepositoryRegistrationState>
      | undefined;
    if (
      (state?.version === 1 || state?.version === 2) &&
      Array.isArray(state.repositories)
    ) {
      for (const raw of state.repositories) {
        const item = storedRoot(raw);
        if (!item) continue;
        const repository = repositoryDescriptor(item.kind, item.root);
        this.repositories.set(repository.id, repository);
        if (item.identity) this.identities.set(repository.id, item.identity);
        const record = raw as Record<string, unknown>;
        this.origins.set(
          repository.id,
          record.origin === "auto" ? "auto" : "manual",
        );
        if (typeof record.ref === "string" && record.ref.length <= 512)
          this.activity.set(repository.id, { ref: record.ref });
        if (record.hidden === true) {
          this.hidden.add(repository.id);
          this.repositories.delete(repository.id);
          this.retained.set(repository.id, repository);
          this.identities.delete(repository.id);
        }
      }
      if (state.version === 2 && state.scan && typeof state.scan === "object") {
        const scan = state.scan as Record<string, unknown>;
        this.scanIncomplete = scan.incomplete === true;
        this.scannedAt =
          typeof scan.scannedAt === "number" ? scan.scannedAt : undefined;
      }
      this.migrationPending = state.version === 1;
    }
    // Persist the v2 envelope on reconstruction even if auto-discovery is
    // disabled and the user never adds a repository in this window.
    if (this.migrationPending) void this.persist().catch(() => {});
    // This performs no Git/CVS process invocation and does not create a
    // service/session. It makes restored manual entries truthful even when the
    // automatic recursive scan is switched off for this workspace.
    this.initialization = this.reconcileSavedRecords();
  }
  /** Await metadata-only restoration reconciliation when deterministic state is needed. */
  ready(): Promise<void> {
    return this.initialization;
  }
  snapshot(): RepositoryCatalogSnapshot {
    const entries: RepositoryCatalogEntry[] = [
      ...new Map([
        ...this.retained.entries(),
        ...this.repositories.entries(),
      ]).values(),
    ]
      .sort(
        (a, b) => a.root.localeCompare(b.root) || a.kind.localeCompare(b.kind),
      )
      .map((repository) => ({
        repository,
        origin: this.origins.get(repository.id) ?? "manual",
        hidden: this.hidden.has(repository.id),
        availability: this.unavailable.has(repository.id)
          ? "unavailable"
          : "available",
        unavailableReason: this.unavailable.get(repository.id),
        activity: this.activity.get(repository.id),
      }));
    return {
      version: 1,
      entries,
      scanning: this.scanning,
      scanIncomplete: this.scanIncomplete,
      scannedAt: this.scannedAt,
    };
  }
  onDidChange(
    listener: (snapshot: RepositoryCatalogSnapshot) => void,
  ): vscode.Disposable {
    this.listeners.add(listener);
    return new vscode.Disposable(() => this.listeners.delete(listener));
  }
  private changed(): void {
    const snapshot = this.snapshot();
    for (const listener of this.listeners) listener(snapshot);
  }
  private async reconcileSavedRecords(): Promise<void> {
    for (const repository of this.repositories.values()) {
      try {
        const actual = await identity(repository);
        const expected = this.identities.get(repository.id);
        if (expected && expected !== actual) {
          this.unavailable.set(
            repository.id,
            vscode.l10n.t(
              "The repository was replaced. Remove it from the list and add it again.",
            ),
          );
          continue;
        }
        if (!expected) this.identities.set(repository.id, actual);
        this.unavailable.delete(repository.id);
        const ref = await readRepositoryReference(
          repository.kind,
          repository.root,
        );
        if (ref)
          this.activity.set(repository.id, {
            ...this.activity.get(repository.id),
            ref,
          });
      } catch {
        this.unavailable.set(
          repository.id,
          vscode.l10n.t(
            "The repository is no longer available in this workspace.",
          ),
        );
      }
    }
    this.changed();
  }
  catalogEntry(id: string): RepositoryCatalogEntry | undefined {
    return this.snapshot().entries.find((entry) => entry.repository.id === id);
  }
  setActivity(id: string, activity: RepositoryCatalogEntry["activity"]): void {
    if (!this.repositories.has(id)) return;
    if (activity) this.activity.set(id, activity);
    else this.activity.delete(id);
    this.changed();
  }
  /** Refresh only a local branch/tag label for an already registered root. */
  async refreshReference(id: string): Promise<void> {
    const repository = this.repositories.get(id);
    if (!repository) return;
    try {
      const ref = await readRepositoryReference(
        repository.kind,
        repository.root,
      );
      this.activity.set(id, { ...this.activity.get(id), ref });
      await this.persist();
      this.changed();
    } catch {
      // This presentation value never controls repository availability.
    }
  }
  private async validate(repository: RepositoryDescriptor): Promise<void> {
    if (!vscode.workspace.isTrusted)
      throw new Error(
        vscode.l10n.t(
          "Trust this workspace before running version control operations.",
        ),
      );
    let allowed = false;
    let aboveWindow = false;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") continue;
      try {
        const root = await fs.realpath(folder.uri.fsPath);
        if (within(root, repository.root)) allowed = true;
        else if (within(repository.root, root)) aboveWindow = true;
      } catch {
        /* Removed workspace folder. */
      }
    }
    if (!allowed && aboveWindow)
      throw new Error(
        vscode.l10n.t(
          "The repository root is outside this window: {0}. Open that root or add it as a workspace folder to use it.",
          repository.root,
        ),
      );
    if (!allowed || (await fs.realpath(repository.root)) !== repository.root)
      throw new Error(
        vscode.l10n.t(
          "The repository is no longer available in this workspace.",
        ),
      );
    const roots = await nearestRepositories(repository.root);
    if (
      !roots.some(
        (item) =>
          item.kind === repository.kind && item.root === repository.root,
      )
    )
      throw new Error(
        vscode.l10n.t(
          "The repository is no longer available in this workspace.",
        ),
      );
  }
  async ensureAvailable(repository: RepositoryDescriptor): Promise<void> {
    if (!this.repositories.has(repository.id))
      throw new Error(
        vscode.l10n.t("Add this repository before running operations."),
      );
    await this.validate(repository);
    await this.establishIdentity(repository);
  }
  private async establishIdentity(
    repository: RepositoryDescriptor,
  ): Promise<void> {
    const previous = this.identityTails.get(repository.id) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        const actual = await identity(repository);
        const expected = this.identities.get(repository.id);
        if (expected && expected !== actual)
          throw new Error(
            vscode.l10n.t(
              "The repository was replaced. Remove it from the list and add it again.",
            ),
          );
        if (!expected) {
          this.identities.set(repository.id, actual);
          // A later scan/update must keep this first-operation identity even if
          // workspaceState is slow; failures are retried by normal persistence.
          void this.persist().catch(() => {});
        }
      });
    this.identityTails.set(repository.id, task);
    try {
      await task;
    } finally {
      if (this.identityTails.get(repository.id) === task)
        this.identityTails.delete(repository.id);
    }
  }
  private async inWorkspace(root: string): Promise<boolean> {
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") continue;
      try {
        if (within(await fs.realpath(folder.uri.fsPath), root)) return true;
      } catch {
        // A folder removed during scan is simply not an allowed root.
      }
    }
    return false;
  }
  private inConfiguredWorkspace(root: string): boolean {
    return (vscode.workspace.workspaceFolders ?? []).some(
      (folder) =>
        folder.uri.scheme === "file" && within(folder.uri.fsPath, root),
    );
  }
  private async sameProjectMember(
    repository: RepositoryDescriptor,
  ): Promise<boolean> {
    if (repository.kind !== "cvs") return false;
    for (const folder of vscode.workspace.workspaceFolders ?? []) {
      if (folder.uri.scheme !== "file") continue;
      try {
        const root = await fs.realpath(folder.uri.fsPath);
        if (
          within(root, repository.root) &&
          (await isCvsSameProject(repository.root, root))
        )
          return true;
      } catch {
        // Unreadable metadata or a removed folder leaves the entry unavailable.
      }
    }
    return false;
  }
  private publishDiscovered(root: {
    kind: RepositoryKind;
    root: string;
    ref?: string;
  }): Promise<void> {
    const repository = repositoryDescriptor(root.kind, root.root);
    const pending = this.discoveryTasks.get(repository.id);
    if (pending) return pending;
    const alreadyRegistered = this.repositories.has(repository.id);
    const task = (async () => {
      if (
        this.hidden.has(repository.id) ||
        !(await this.inWorkspace(repository.root))
      )
        return;
      const existing = this.repositories.get(repository.id);
      if (!existing) {
        // Do not expose an auto-discovered repository before its identity is
        // captured. Otherwise a user could operate a replacement during scan.
        const fingerprint = await identity(repository);
        if (this.hidden.has(repository.id)) return;
        this.repositories.set(repository.id, repository);
        this.origins.set(repository.id, "auto");
        this.identities.set(repository.id, fingerprint);
      } else if (!this.identities.has(repository.id)) {
        this.identities.set(repository.id, await identity(existing));
      }
      this.unavailable.delete(repository.id);
      if (root.ref)
        this.activity.set(repository.id, {
          ...this.activity.get(repository.id),
          ref: root.ref,
        });
    })()
      .catch((_error) => {
        if (!alreadyRegistered) {
          this.repositories.delete(repository.id);
          this.retained.set(repository.id, repository);
          this.origins.set(repository.id, "auto");
        }
        this.unavailable.set(
          repository.id,
          vscode.l10n.t(
            "The repository is no longer available in this workspace.",
          ),
        );
      })
      .finally(() => {
        this.discoveryTasks.delete(repository.id);
        this.changed();
      });
    this.discoveryTasks.set(repository.id, task);
    return task;
  }
  private async persist(): Promise<void> {
    const state: RepositoryRegistrationState = {
      version: 2,
      // Retained hidden descriptors are intentional tombstones, not live
      // registrations. Persist them so discovery cannot undo removal.
      repositories: [
        ...new Map([
          ...this.retained.entries(),
          ...this.repositories.entries(),
        ]).values(),
      ].map(({ kind, root, id }) => ({
        kind,
        root,
        identity: this.identities.get(id),
        origin: this.origins.get(id) ?? "manual",
        hidden: this.hidden.has(id) || undefined,
        ref: this.activity.get(id)?.ref,
      })),
      scan: {
        incomplete: this.scanIncomplete || undefined,
        scannedAt: this.scannedAt,
      },
    };
    this.saveTail = this.saveTail
      .catch(() => {})
      .then(async () => {
        await this.storage?.save(state);
      });
    await this.saveTail;
    this.migrationPending = false;
  }
  async register(
    repository: RepositoryDescriptor,
    origin: RepositoryOrigin = "manual",
  ): Promise<RepositoryDescriptor> {
    await this.validate(repository);
    const existing = this.repositories.get(repository.id);
    if (existing) {
      await this.ensureAvailable(existing);
      if (origin === "manual") this.origins.set(existing.id, "manual");
      this.hidden.delete(existing.id);
      this.unavailable.delete(existing.id);
      await this.persist();
      await this.refreshReference(existing.id);
      this.changed();
      return existing;
    }
    this.repositories.set(repository.id, repository);
    this.origins.set(repository.id, origin);
    this.hidden.delete(repository.id);
    this.unavailable.delete(repository.id);
    this.identities.set(repository.id, await identity(repository));
    await this.persist();
    await this.refreshReference(repository.id);
    this.changed();
    return repository;
  }
  async remove(id: string): Promise<void> {
    const repository = this.repositories.get(id) ?? this.retained.get(id);
    if (repository) this.retained.set(id, repository);
    // Keep a tombstone in workspace state. A later recursive scan must not
    // silently put a user-removed nested root back in the visible catalog.
    if (repository) {
      this.hidden.add(id);
      this.repositories.delete(id);
      this.identities.delete(id);
    }
    this.release(id);
    await this.persist();
    this.changed();
  }
  private release(id: string): void {
    // Keep the mounted page/draft. Its existing guard refuses all new work
    // until this exact root is explicitly added again.
    this.sessions.get(id)?.cancel?.();
    if (this.activeId === id) this.activeId = undefined;
  }
  /** 删除整条登记，不留隐藏记录；以后再被发现时按新的自动登记回来。 */
  private forget(id: string): void {
    this.repositories.delete(id);
    this.retained.delete(id);
    this.origins.delete(id);
    this.identities.delete(id);
    this.activity.delete(id);
    this.unavailable.delete(id);
    this.release(id);
  }
  async restoreHidden(id?: string): Promise<void> {
    const targets = id ? [id] : [...this.hidden];
    for (const target of targets) {
      this.hidden.delete(target);
      const repository = this.retained.get(target);
      if (!repository) continue;
      // A restored but unavailable root remains manageable: it is listed so
      // the user can hide/remove it again, while ensureAvailable still refuses
      // every operation until the normal boundary validation succeeds.
      this.repositories.set(target, repository);
      try {
        await this.validate(repository);
        this.identities.set(target, await identity(repository));
      } catch (_error) {
        this.unavailable.set(
          target,
          vscode.l10n.t(
            "The repository is no longer available in this workspace.",
          ),
        );
      }
    }
    await this.persist();
    this.changed();
  }
  /**
   * Metadata-only recursive discovery. It never invokes Git/CVS or creates a
   * repository service. A scan is deliberately non-destructive on cancellation
   * or unreadable paths: stale saved entries remain visible and removable.
   */
  async scanWorkspace(
    options: DiscoveryOptions = {},
  ): Promise<DiscoveryProgress> {
    if (!vscode.workspace.isTrusted)
      throw new Error(
        vscode.l10n.t("Trust this workspace before scanning repositories."),
      );
    this.scanning = true;
    this.changed();
    const results: DiscoveryProgress[] = [];
    const published = new Set<string>();
    const folders = (vscode.workspace.workspaceFolders ?? []).filter(
      (folder) => folder.uri.scheme === "file",
    );
    try {
      for (const folder of folders) {
        if (options.signal?.aborted) break;
        let result: DiscoveryProgress;
        try {
          result = await discoverRepositoryRoots(folder.uri.fsPath, {
            ...options,
            onProgress: (progress) => {
              for (const root of progress.roots) {
                const key = `${root.kind}\0${root.root}`;
                if (!published.has(key)) {
                  published.add(key);
                  void this.publishDiscovered(root);
                }
              }
              options.onProgress?.(progress);
            },
          });
        } catch (error) {
          result = {
            roots: [],
            incomplete: true,
            cancelled: Boolean(options.signal?.aborted),
            errors: [
              error instanceof Error
                ? error.message
                : "Unable to scan workspace folder",
            ],
          };
        }
        results.push(result);
        for (const root of result.roots) {
          await this.publishDiscovered(root);
        }
      }
      this.scanIncomplete =
        options.signal?.aborted === true ||
        results.some((result) => result.incomplete);
      this.scannedAt = Date.now();
      // Only a complete scan may change saved entries. Cancellation and
      // unreadable directories deliberately preserve their last known state.
      // A stale automatic entry is deleted; a manual one stays, and is marked
      // unavailable unless it is a same-project CVS directory, which discovery
      // deliberately does not list. Both checks read metadata only.
      if (!this.scanIncomplete) {
        const discoveredIds = new Set(
          results
            .flatMap((result) => result.roots)
            .map((root) => repositoryDescriptor(root.kind, root.root).id),
        );
        const saved = new Map([
          ...this.retained.entries(),
          ...this.repositories.entries(),
        ]);
        for (const repository of saved.values()) {
          if (
            this.hidden.has(repository.id) ||
            !this.inConfiguredWorkspace(repository.root)
          )
            continue;
          if (discoveredIds.has(repository.id)) {
            this.unavailable.delete(repository.id);
          } else if (this.origins.get(repository.id) === "auto") {
            this.forget(repository.id);
          } else if (this.repositories.has(repository.id)) {
            if (await this.sameProjectMember(repository))
              this.unavailable.delete(repository.id);
            else
              this.unavailable.set(
                repository.id,
                vscode.l10n.t(
                  "The repository is no longer available in this workspace.",
                ),
              );
          }
        }
      }
      await this.persist();
      const roots = results.flatMap((result) => result.roots);
      return {
        roots,
        incomplete: this.scanIncomplete,
        cancelled: results.some((result) => result.cancelled),
        errors: results.flatMap((result) => result.errors),
      };
    } finally {
      this.scanning = false;
      this.changed();
    }
  }
  async candidates(uri?: vscode.Uri): Promise<RepositoryDescriptor[]> {
    if (!vscode.workspace.isTrusted)
      throw new Error(
        vscode.l10n.t(
          "Trust this workspace before running version control operations.",
        ),
      );
    const starts =
      uri?.scheme === "file"
        ? [uri.fsPath]
        : (vscode.workspace.workspaceFolders ?? [])
            .filter((f) => f.uri.scheme === "file")
            .map((f) => f.uri.fsPath);
    const found = new Map<string, RepositoryDescriptor>();
    for (const start of starts) {
      try {
        for (const item of await nearestRepositories(start)) {
          const repository = repositoryDescriptor(item.kind, item.root);
          await this.validate(repository);
          found.set(repository.id, repository);
        }
      } catch (error) {
        if (uri) throw error;
      }
    }
    if (!uri) {
      for (const raw of Array.isArray(this.storage?.saved)
        ? this.storage.saved
        : []) {
        const item = storedRoot(raw);
        if (!item) continue;
        try {
          const repository = repositoryDescriptor(
            item.kind,
            await fs.realpath(item.root),
          );
          await this.validate(repository);
          found.set(repository.id, repository);
        } catch {
          /* Historical candidate is no longer present. */
        }
      }
      for (const repository of this.retained.values()) {
        try {
          await this.validate(repository);
          found.set(repository.id, repository);
        } catch {
          /* Removed on disk. */
        }
      }
    }
    return [...found.values()];
  }
  /** Compatibility for internal consumers: return registered roots only. */
  async discover(uri?: vscode.Uri): Promise<RepositoryDescriptor[]> {
    if (uri)
      return (await this.candidates(uri)).filter((item) =>
        this.repositories.has(item.id),
      );
    const result: RepositoryDescriptor[] = [];
    for (const repository of this.repositories.values()) {
      try {
        await this.ensureAvailable(repository);
        result.push(repository);
      } catch {
        /* Keep unavailable entries removable. */
      }
    }
    return result;
  }
  hierarchy(): Array<{
    repository: RepositoryDescriptor;
    depth: number;
    relative: string;
  }> {
    const roots = [...this.repositories.values()].sort(
      (a, b) => a.root.localeCompare(b.root) || a.kind.localeCompare(b.kind),
    );
    return roots.map((repository) => {
      const ancestors = roots.filter(
        (parent) =>
          parent.root !== repository.root &&
          within(parent.root, repository.root),
      );
      const parent = ancestors.sort((a, b) => b.root.length - a.root.length)[0];
      return {
        repository,
        depth: new Set(ancestors.map((item) => item.root)).size,
        relative: parent
          ? path.relative(parent.root, repository.root)
          : repository.root,
      };
    });
  }
  private async pick(
    candidates: RepositoryDescriptor[],
  ): Promise<RepositoryDescriptor | undefined> {
    if (!candidates.length) return;
    if (candidates.length === 1) return candidates[0];
    const entries = candidates.map((repository) => ({
      label: `${path.basename(repository.root)} [${repository.kind === "git" ? "Git" : "CVS"}]`,
      description: repository.root,
      repository,
    }));
    return (
      await vscode.window.showQuickPick(entries, {
        title: vscode.l10n.t("Select repository"),
      })
    )?.repository;
  }
  async add(uri?: vscode.Uri): Promise<RepositoryDescriptor | undefined> {
    let selected = uri;
    if (!selected)
      selected = (
        await vscode.window.showOpenDialog({
          canSelectFiles: false,
          canSelectFolders: true,
          canSelectMany: false,
          openLabel: vscode.l10n.t("Add Repository"),
        })
      )?.[0];
    if (!selected || selected.scheme !== "file") return;
    const repository = await this.pick(await this.candidates(selected));
    if (!repository) {
      void vscode.window.showInformationMessage(
        vscode.l10n.t(
          "Open a Git repository or CVS working copy in this workspace.",
        ),
      );
      return;
    }
    return this.register(repository);
  }
  private async confirmRegistration(
    repository: RepositoryDescriptor,
  ): Promise<RepositoryDescriptor | undefined> {
    if (this.repositories.has(repository.id)) {
      await this.ensureAvailable(repository);
      return repository;
    }
    const add = vscode.l10n.t("Add and Open");
    const result = await vscode.window.showInformationMessage(
      vscode.l10n.t("This repository has not been added: {0}", repository.root),
      add,
    );
    return result === add ? this.register(repository) : undefined;
  }
  async choose(
    uri?: vscode.Uri,
    kind?: RepositoryKind,
  ): Promise<RepositoryDescriptor | undefined> {
    if (uri?.scheme === "jettortoise") {
      const repository = this.repositories.get(uri.authority);
      if (repository && (!kind || repository.kind === kind)) {
        await this.ensureAvailable(repository);
        return repository;
      }
      return;
    }
    if (uri?.scheme === "file") {
      // Filter kind only after choosing the nearest physical boundary. A Git
      // command on a CVS child's file must never fall back to its Git parent.
      const repository = await this.pick(
        (await this.candidates(uri)).filter(
          (item) => !kind || item.kind === kind,
        ),
      );
      return repository ? this.confirmRegistration(repository) : undefined;
    }
    if (!vscode.workspace.isTrusted)
      throw new Error(
        vscode.l10n.t(
          "Trust this workspace before running version control operations.",
        ),
      );
    const validIds = new Set((await this.discover()).map((item) => item.id));
    const entries = this.hierarchy()
      .filter(
        (item) =>
          validIds.has(item.repository.id) &&
          (!kind || item.repository.kind === kind),
      )
      .map(({ repository, depth, relative }) => ({
        label: `${"  ".repeat(depth)}${depth ? "↳ " : ""}${path.basename(repository.root)} [${repository.kind === "git" ? "Git" : "CVS"}]`,
        description: relative,
        detail: repository.root,
        repository,
      }));
    const pending = (await this.candidates()).filter(
      (item) =>
        !this.repositories.has(item.id) && (!kind || item.kind === kind),
    );
    const picked = await vscode.window.showQuickPick(
      [
        ...entries,
        ...pending.map((repository) => ({
          label: vscode.l10n.t("Add: {0}", path.basename(repository.root)),
          description: repository.root,
          detail: repository.kind,
          repository,
        })),
        {
          label: vscode.l10n.t("Add Repository..."),
          description: "",
          detail: "",
          repository: undefined,
        },
      ],
      { title: vscode.l10n.t("Select repository") },
    );
    if (!picked) return;
    return picked.repository
      ? this.confirmRegistration(picked.repository)
      : this.add();
  }
  async removeWithPicker(): Promise<void> {
    const picked = await vscode.window.showQuickPick(
      this.hierarchy().map(({ repository }) => ({
        label: `${path.basename(repository.root)} [${repository.kind}]`,
        description: repository.root,
        repository,
      })),
      { title: vscode.l10n.t("Remove Repository from List") },
    );
    if (picked) await this.remove(picked.repository.id);
  }
  async session(repository: RepositoryDescriptor): Promise<RepositorySession> {
    await this.ensureAvailable(repository);
    return this.materialize(repository);
  }
  private materialize(repository: RepositoryDescriptor): RepositorySession {
    let session = this.sessions.get(repository.id);
    if (!session) {
      session = this.factory(
        repository,
        () => this.ensureAvailable(repository),
        () => {
          this.activeId = repository.id;
          void vscode.commands.executeCommand(
            "setContext",
            "jettortoise.activeProvider",
            repository.kind,
          );
        },
      );
      this.sessions.set(repository.id, session);
    }
    return session;
  }
  async fromState(value: unknown): Promise<RepositoryDescriptor> {
    const item = storedRoot(
      (value as { repository?: unknown } | undefined)?.repository,
    );
    if (!item)
      throw new Error(
        vscode.l10n.t(
          "Saved repository state is unavailable. Open the repository again.",
        ),
      );
    const repository = repositoryDescriptor(
      item.kind,
      await fs.realpath(item.root),
    );
    await this.validate(repository);
    return repository;
  }
  async restore(panel: vscode.WebviewPanel, state: unknown): Promise<void> {
    const repository = await this.fromState(state);
    await this.confirmRegistration(repository);
    // Cancelling registration must not discard a restored CVS draft/layout.
    // The mounted page has no operation permission until explicit registration.
    this.retained.set(repository.id, repository);
    await this.materialize(repository).restore(panel);
  }
  async resolveUri(uri: vscode.Uri): Promise<RepositorySession> {
    if (uri.scheme !== "jettortoise")
      throw vscode.FileSystemError.NoPermissions();
    const repository = this.repositories.get(uri.authority);
    if (!repository) throw vscode.FileSystemError.FileNotFound();
    return this.session(repository);
  }
  async invalidateRemoved(): Promise<void> {
    // Keep pages and drafts mounted. Their guards reject an unavailable root;
    // a refresh never silently rebinds a page to a different repository.
    for (const [id, session] of this.sessions) {
      const repository = this.repositories.get(id);
      try {
        if (!repository) throw new Error();
        await this.ensureAvailable(repository);
      } catch {
        session.cancel?.();
        if (this.activeId === id) this.activeId = undefined;
      }
    }
  }
  dispose(): void {
    for (const session of this.sessions.values()) session.dispose();
    this.sessions.clear();
    this.repositories.clear();
  }
}
