<a name="readme-top"></a>

<div align="center">

<img src="https://raw.githubusercontent.com/aotemj/jetbrains-git-graph/main/images/assets/logo-128.png" width="80" />

<h1>JetTortoise</h1>

IDEA-style Commit and Log for Git and CVS across workspace repositories. Changes are grouped by repository and directory; unversioned files and incoming updates stay separate. Git retains the upstream graph, shelf, and branch tools; CVS provides file revision history.

> Fork of [zhyc9de/jet-git](https://github.com/zhyc9de/jet-git) with full IntelliJ IDEA-style context menus and UI enhancements.

**English** · [简体中文](./README.zh_CN.md)

</div>

---

## Features

### Branch Context Menu

Right-click any branch to checkout, create, merge, rebase, rename, delete, push, or pull — just like IntelliJ IDEA.

![Branch Checkout](https://raw.githubusercontent.com/aotemj/jetbrains-git-graph/main/images/checkout.gif)

### Commit Context Menu

Right-click any commit to copy hash, cherry-pick, checkout revision, reset, revert, create branch or tag.

![Commit Context Menu](https://raw.githubusercontent.com/aotemj/jetbrains-git-graph/main/images/commit-context-menu.gif)

### Changed Files Context Menu

Right-click files in the Changed Files panel: show diff, edit source, open repository version, revert/cherry-pick file changes, copy path.

### Git Graph

![Git Graph](https://raw.githubusercontent.com/aotemj/jetbrains-git-graph/main/images/git-graph.png)

- **Branch Tree** — branches organized by Local / Remote / Tags with search filter
- **Commit List** — color-coded branch lines, resizable columns (Message, Author, Date, Hash)
- **Detail Panel** — commit message and changed file tree
- **Filters** — filter by Branch, User, Date range

### 3-Way Merge Editor

![3-Way Merge Editor](https://raw.githubusercontent.com/aotemj/jetbrains-git-graph/main/images/three-way-merge.png)

- Three-column layout: Theirs | Result | Yours
- Conflict highlighting with per-block action buttons
- Full syntax highlighting

### Conflict Management

![Conflict List](https://raw.githubusercontent.com/aotemj/jetbrains-git-graph/main/images/conflicts-list.png)

- Quick actions: Accept Yours / Accept Theirs / Merge
- Integration with VS Code Source Control panel

---

## All Context Menu Actions

<details>
<summary><b>Branch (right-click)</b></summary>

- Checkout
- New Branch from...
- Checkout and Rebase onto current
- Rebase current onto branch
- Merge into current
- Rename (local only)
- Delete (with force-delete fallback)
- Update (pull)
- Push

</details>

<details>
<summary><b>Commit (right-click)</b></summary>

- Copy Revision Number
- Cherry-Pick
- Checkout Revision
- Reset Current Branch to Here (Mixed/Soft/Hard)
- Revert Commit
- New Branch...
- New Tag...

</details>

<details>
<summary><b>Changed Files (right-click)</b></summary>

- Show Diff
- Edit Source
- Open Repository Version
- Revert Selected Changes
- Cherry-Pick Selected Changes
- Copy Path
- Copy File Name

</details>

---

## Installation

The 0.6 line is published as GitHub pre-releases and is not on the Marketplace yet (Marketplace ID `jieyuexing.jettortoise` only has 0.5.0).

1. Download `jettortoise-<version>.vsix` from [Releases](https://github.com/jieyuexing/vscode-jettortoise-plugin/releases)
2. `Cmd+Shift+P` → "Extensions: Install from VSIX..."

## Requirements

- VS Code 1.85.0+
- Git in PATH for Git repositories
- A CVS client (`cvs`, CVSNT on Windows) in PATH for CVS repositories

## Local Development

```bash
git clone https://github.com/jieyuexing/vscode-jettortoise-plugin.git
cd vscode-jettortoise-plugin
git checkout restart
pnpm install
cd webview && pnpm install && cd ..
```

Press **F5** to launch Extension Development Host.

```bash
pnpm run watch          # Watch mode
pnpm run check-types    # Type check
pnpm run lint           # Biome
pnpm run test:headless  # Repository, Git/CVS and UI checks
pnpm run vsce:package   # Package release/jettortoise-<version>.vsix
```

## Credits

- Original: [zhyc9de/jet-git](https://github.com/zhyc9de/jet-git)
- Icons: [IntelliJ IDEA Icons](https://intellij-icons.jetbrains.design/) (Apache 2.0)

## License

[MIT](./LICENSE)
