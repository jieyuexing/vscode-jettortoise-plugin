import * as vscode from "vscode";
import { assertOwnedPath, within } from "../repositories/boundaries.cjs";
import type { RepositoryRegistry } from "../repositories/registry";
import type {
  RepositoryCatalogSnapshot,
  RepositoryDescriptor,
} from "../repositories/types";
import { RepositoryScm, type ScmResource } from "./provider";

export class ScmManager implements vscode.Disposable {
  private readonly providers = new Map<string, RepositoryScm>();
  private readonly creating = new Set<string>();
  private readonly decorations = new vscode.EventEmitter<vscode.Uri[]>();
  private readonly disposables: vscode.Disposable[] = [];
  private disposed = false;
  private prompts = Promise.resolve();
  constructor(
    private readonly registry: RepositoryRegistry,
    private readonly context: vscode.ExtensionContext,
  ) {
    this.disposables.push(
      this.decorations,
      registry.onDidChange((snapshot) => {
        void this.sync(snapshot);
      }),
      vscode.window.registerFileDecorationProvider({
        onDidChangeFileDecorations: this.decorations.event,
        provideFileDecoration: async (uri) => {
          const providers = [...this.providers.values()]
            .filter((item) => within(item.repository.root, uri.fsPath))
            .sort(
              (a, b) => b.repository.root.length - a.repository.root.length,
            );
          for (const provider of providers) {
            const decoration = provider.decoration(uri);
            if (!decoration) continue;
            const relative = uri.fsPath.slice(
              provider.repository.root.length + 1,
            );
            try {
              await assertOwnedPath(
                provider.repository.root,
                provider.repository.kind,
                relative,
              );
              return decoration;
            } catch {
              return;
            }
          }
        },
      }),
      vscode.window.onDidChangeWindowState((state) => {
        if (state.focused) void this.sync(this.registry.snapshot(), true);
      }),
      vscode.workspace.onDidChangeWorkspaceFolders(() => {
        void this.sync(this.registry.snapshot(), true);
      }),
      vscode.workspace.onDidGrantWorkspaceTrust(() => {
        void this.sync(this.registry.snapshot());
      }),
    );
    for (const action of [
      "refresh",
      "commit",
      "diff",
      "defer",
      "include",
      "rollback",
      "add",
      "ignore",
    ])
      this.disposables.push(
        vscode.commands.registerCommand(
          `jettortoise.scm.${action}`,
          async (...args: unknown[]) => {
            try {
              const first = args[0] as
                | ScmResource
                | vscode.SourceControl
                | vscode.SourceControlResourceGroup
                | undefined;
              const provider = [...this.providers.values()].find(
                (item) =>
                  item.sourceControl === first ||
                  [...item.groups.values()].includes(
                    first as vscode.SourceControlResourceGroup,
                  ) ||
                  (first as ScmResource)?.owner === item,
              );
              if (!provider) return;
              await this.registry.ensureAvailable(provider.repository);
              if (action === "refresh") return provider.refresh(true);
              if (action === "commit") return provider.commit();
              const paths =
                action === "diff"
                  ? [String(args[1])]
                  : [...provider.groups.values()].includes(
                        first as vscode.SourceControlResourceGroup,
                      )
                    ? provider.pathsIn(
                        first as vscode.SourceControlResourceGroup,
                      )
                    : args
                        .filter(
                          (arg): arg is ScmResource =>
                            (arg as ScmResource)?.owner === provider,
                        )
                        .map((item) => item.change.path);
              await provider.action(action, paths);
            } catch (error) {
              void vscode.window.showErrorMessage(
                error instanceof Error
                  ? error.message
                  : vscode.l10n.t(
                      "JetTortoise could not complete the operation.",
                    ),
              );
            }
          },
        ),
      );
    void this.sync(registry.snapshot());
  }
  private eligible(snapshot: RepositoryCatalogSnapshot, id: string) {
    return (
      vscode.workspace.isTrusted &&
      snapshot.entries.some(
        (entry) =>
          entry.repository.id === id &&
          !entry.hidden &&
          entry.availability === "available",
      )
    );
  }
  private async sync(snapshot: RepositoryCatalogSnapshot, focus = false) {
    if (this.disposed) return;
    for (const [id, provider] of this.providers) {
      if (!this.eligible(snapshot, id)) {
        provider.dispose();
        this.providers.delete(id);
        continue;
      }
      if (focus) {
        try {
          await this.registry.ensureAvailable(provider.repository);
          void provider.refresh(false);
        } catch {
          provider.dispose();
          this.providers.delete(id);
        }
      }
    }
    for (const entry of snapshot.entries) {
      const repository = entry.repository;
      if (
        !this.eligible(snapshot, repository.id) ||
        this.providers.has(repository.id) ||
        this.creating.has(repository.id)
      )
        continue;
      this.creating.add(repository.id);
      try {
        const session = await this.registry.session(repository);
        if (
          !session.scm ||
          this.disposed ||
          !this.eligible(this.registry.snapshot(), repository.id)
        )
          continue;
        this.providers.set(
          repository.id,
          new RepositoryScm(
            repository,
            session.scm,
            this.context,
            this.decorations,
          ),
        );
        if (repository.kind === "git")
          this.prompts = this.prompts
            .then(() => this.promptGit(repository))
            .catch(() => {});
      } catch {
        /* 不可用仓库不会创建原生提供者，操作入口仍独立校验。 */
      } finally {
        this.creating.delete(repository.id);
      }
    }
  }
  private async promptGit(repository: RepositoryDescriptor) {
    const key = `scm.gitPrompt.${repository.id}`;
    if (this.disposed || this.context.workspaceState?.get<boolean>(key)) return;
    await this.context.workspaceState?.update(key, true);
    const config = vscode.workspace.getConfiguration("git");
    if (
      config.get<string[]>("ignoredRepositories", []).includes(repository.root)
    )
      return;
    const confirm = vscode.l10n.t("Ignore Built-in Git for This Repository");
    const choice = await vscode.window.showInformationMessage(
      vscode.l10n.t(
        "Ignore built-in Git management of this repository in this workspace? Reload the window to apply this to an already open repository. After reload, this repository also disappears from the built-in Git extension API: {0}",
        repository.root,
      ),
      confirm,
      vscode.l10n.t("Keep Both"),
    );
    if (choice !== confirm || this.disposed) return;
    await this.registry.ensureAvailable(repository);
    const current = config.get<string[]>("ignoredRepositories", []);
    await config.update(
      "ignoredRepositories",
      [...new Set([...current, repository.root])],
      vscode.ConfigurationTarget.Workspace,
    );
  }
  dispose() {
    this.disposed = true;
    for (const provider of this.providers.values()) provider.dispose();
    this.providers.clear();
    for (const disposable of this.disposables) disposable.dispose();
  }
}
