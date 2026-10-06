# JetTortoise

An IntelliJ IDEA-style Git and CVS workspace for VS Code.

English | [简体中文](./README.zh_CN.md)

Review local changes and repository history in one editor tab with **Repositories and Navigation · Commit** on the left, a read-only diff above **History · Details** on the right. Each Git repository or CVS working copy has its own tab, state, and operations. JetTortoise is an independent open-source project.

## Features

- **One tab per repository.** Open multiple repositories side by side. Reopening the same repository focuses its existing tab; the full path distinguishes repositories with the same name.
- **Repository catalog.** Recursively discover Git/CVS roots at every level inside workspace folders. The hierarchy shows repository type and branch/tag; automatic, manual, and hidden entries persist with the workspace. Update another repository from its context menu without switching tabs.
- **Read-only diff workbench.** Select working files and write a commit on the left, preview split or inline changes above independently selected history. Resize or collapse auxiliary columns; expand and restore diff. Narrow windows temporarily collapse Details, then repository navigation.
- **Git.** Commit graph, branches/tags, file history, diffs, commit/amend, Shelf/Stash, Push/Rollback, conflicts, and three-way merge.
- **CVS.** Local client checkout, working-copy status, file revision history, comparison, commit, update, cancellation, and confirmed rollback with a sibling backup. CVS history uses file revision numbers; Git-only actions are not shown.
- **Display language.** Follows VS Code. English is the default; `zh`, `zh-cn`, and `zh-tw` use Simplified Chinese. Other languages use English. Changing VS Code's display language takes effect after Reload.

## Git history and merge

Browse commits and branches, inspect changed files, and open contextual operations. These screenshots illustrate the existing Git features; the combined repository workspace is described above.

![Git history](./images/git-graph.png)

![Commit context menu](./images/commit-context-menu.gif)

![Conflict list](./images/conflicts-list.png)

![Three-way merge](./images/three-way-merge.png)

## Install

Install the development dependencies below, then build the package:

```sh
pnpm run vsce:package
code --install-extension release/jettortoise-0.4.17.vsix
```

Alternatively, use **Extensions: Install from VSIX...** and select `release/jettortoise-0.4.17.vsix`. Git support requires a local Git client. CVS support requires a local `cvs` client; set `jettortoise.cvsPath` when it is not on PATH. JetTortoise does not download a client automatically.

Discovery starts automatically in trusted local workspace folders, never scans outer ancestors, and skips directory symlinks. The catalog offers search, add, rescan, and restore-hidden controls; repository menus open a workbench or commit area, update files, refresh status, copy the path, or remove an entry. Registrations persist in the current workspace. Disable `jettortoise.autoDiscoverRepositories` to stop automatic scanning without deleting the list; manual scanning remains available. Cancelled or partially failed scans are marked incomplete.

**Update repository files** only fast-forwards the current Git branch from its upstream. Dirty files/index, unsaved editors, missing upstream, detached HEAD, divergence, and unsafe nested boundaries are rejected. CVS retains its existing update and boundary checks. Updating does not switch the active tab.

Select a working or historical file to preview its diff. Git staged changes compare HEAD ↔ index, unstaged changes compare index ↔ disk; CVS compares Entries/selected revision ↔ working copy. Each side is limited to 2 MiB and 20,000 lines; binary or oversized content offers the native diff. Preview is read-only, warns about unsaved editors, and never persists file bodies in webview state.

A file belongs to its nearest repository boundary. An unregistered child offers **Add and Open**; cancelling keeps it out of the parent. Parent writes cannot cross into children, even after a child is removed from the list. Operations whose full effect cannot be proven safe are paused when children exist. See [nested repository behavior](./docs/nested-repositories.md).

Opening a subdirectory in its own VS Code window does not bring in an outer repository. An independent child repository can be added; a plain subdirectory reports that its actual root is outside the window. Open that root or add it as a workspace folder to use it. VS Code's built-in Git Source Control view has separate discovery settings.

This is a new extension identity, `jetgit.jettortoise`. Old JetGit/JetCVS commands and private state are not imported. See [migration instructions](./docs/migration.md) for commands, shortcuts, CVS configuration, and rollback.

## Security and privacy

The reviewed source has no dedicated telemetry, analytics client, or automatic workspace upload. Repository data is processed locally. Git remote operations and CVS server operations run through the installed clients and their configuration; Git may execute configured hooks, filters, and credential helpers. CVS uses existing client authentication and rejects passwords embedded in repository addresses.

Shelf/patch files and CVS rollback backups remain on disk. Copy/import actions use the system clipboard. Each tab stores its own layout and history preferences in VS Code; Git commit drafts stay in page memory, while CVS commit drafts use webview state. Repository operations require a trusted local workspace.

Input, path, and confirmation boundaries have dedicated regression checks. Remaining dependency risks, filesystem race limits, and unverified runtime scenarios are documented in the [security review](./docs/security-review.md). These checks are not a guarantee that the project is free of vulnerabilities.

## Development

```sh
git clone https://github.com/jieyuexing/vscode-jettortoise-plugin.git
cd vscode-jettortoise-plugin
pnpm install
(cd webview && pnpm install)
pnpm run build
```

Use `pnpm run watch` for incremental builds. Open this directory in VS Code and press **F5** to launch an Extension Development Host. Automated headless checks are documented in the [validation record](./docs/jettortoise-validation.md). Real VS Code window tests are separate and are not launched by these checks.

Both adapters compile `packages/vcs-ui` directly from this repository. Building or running JetTortoise does not require the old JetCVS source directory or a downloaded UI snapshot.

## License

[MIT](./LICENSE). Original copyright notices are retained. [CVS import provenance](./docs/cvs-import.md) records the local implementation source; no IntelliJ integration or protocol library is bundled.

## Acknowledgments

- [aotemj/jetbrains-git-graph](https://github.com/aotemj/jetbrains-git-graph)
- [zhyc9de/jet-git](https://github.com/zhyc9de/jet-git)
- [IntelliJ IDEA Icons](https://intellij-icons.jetbrains.design/) — Apache-2.0
