# JetTortoise Project Guide

This repository owns one VS Code extension: `jetgit.jettortoise`, version `0.4.17`.
Git and CVS share presentation code and a Host registry, not repository data.

## Source boundaries

- `src/extension.ts`: implemented command registration, aggregate URI providers, serializer and status bar.
- `src/repositories/`: canonical repository identity, persisted workspace catalog, metadata-only recursive discovery, targeted boundary queries and session dispatch.
- `src/git/session.ts`: repository-bound Git Host handlers, mutation queue and confirmations.
- `src/git/`: Git CLI, input/file boundaries, graph calculation and cache.
- `src/cvs/`: migrated CVS CLI, protocol and repository session. Preserve cancellation, timeouts, redaction and path checks.
- `src/messages/`: explicit Git message/surface schemas. New handlers need a runtime contract.
- `src/views/`: repository-owned editor panels, URI generation and escaped HTML.
- `webview/src/panel/`, `commit/`, `cvs/`: Git and CVS consumers of `packages/vcs-ui`.
- `packages/vcs-ui`: local browser-only source, themes, layouts and components. No Node, VS Code or VCS core imports; no cross-repository synchronization.

## Contracts

One `kind + canonical root` owns one history panel (`jettortoise.workspace`). Different roots have separate services, queues, watchers, state, messages and diff authority. Webviews cannot choose cwd. Destructive confirmations must be bound to the executed Host request. Reject new actions after workspace removal or loss of trust.

Registration is workspace-local: automatic recursive metadata discovery is enabled by default, with manual entries and persistent hidden tombstones. A scan must not invoke VCS/network operations or escape workspace folders. The closest physical repository owns a file even if unregistered; cancellation must never fall back to an ancestor. A child window cannot borrow a root above its workspace folders. Revalidate boundaries at execution time, inspect the full Git index before committing, and reject unprovable whole-tree writes when nested repositories exist. Removing registration never removes child protection. See `docs/nested-repositories.md`.

The repository-first workbench places a read-only diff above history/details and keeps Commit mounted during history loading/errors and column collapse. Git's single webview state writer merges repository identity, history, layout and diff selection/mode (never file bodies); its drafts stay in memory. CVS retains its existing draft state strategy. Do not read legacy extension storage or register `git-brains.*` / `jetcvs.*` aliases.

Language follows `vscode.env.language`. Maintain English and Simplified Chinese only; `zh`, `zh-cn`, `zh-tw` select Simplified Chinese, other locales select English. Host uses `vscode.l10n.t`, manifest uses package.nls and webview dictionaries initialize from Host data.

## Build and checks

Use the declared pnpm version; do not upgrade dependencies as part of UI work.

```sh
pnpm run check:l10n
pnpm run build
pnpm run test:headless
pnpm run vsce:package
```

The package is `release/jettortoise-0.4.17.vsix`; keep `release/` ignored. Headless fixtures and mocked VS Code checks do not prove actual window interaction, Reload or installation behavior. Do not start GUI test hosts without a separate user request. Historical GUI scripts are not part of headless validation.
