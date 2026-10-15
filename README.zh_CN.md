# JetTortoise

IntelliJ IDEA 风格的 VS Code Git / CVS 工作面板。

[English](./README.md) | 简体中文

在一个编辑器标签页内查看本地变更和仓库历史，左侧为 **仓库列表与导航 · 提交区**，右侧上方为只读 diff，下方为 **历史 · 详情**。每个 Git 仓库或 CVS 工作副本使用独立的标签页、状态与操作。

JetTortoise 是独立开源项目，与 JetBrains、TortoiseGit、TortoiseCVS 均无隶属关系。

[扩展市场](https://marketplace.visualstudio.com/items?itemName=jieyuexing.jettortoise) ·
[Releases](https://github.com/jieyuexing/vscode-jettortoise-plugin/releases) ·
[更新日志](./CHANGELOG.md) ·
许可证：[MIT](./LICENSE)

## 核心特点

- **按仓库打开。** 多个仓库可同时打开、并排查看；重复打开同一仓库会聚焦已有标签，完整路径用于区分同名仓库。
- **仓库列表。** 默认递归发现当前工作区内各层 Git/CVS 仓库，按层级显示类型与分支/标签；手动添加、自动发现和隐藏项随工作区保存。右键可更新指定仓库而不切换标签。
- **只读 diff 工作台。** 左侧选择待提交文件并填写说明，右侧上方查看左右或行内差异，下方独立浏览历史。各栏可调整宽度和折叠，diff 可展开后恢复；窄窗口先收起详情，再收起仓库导航。
- **Git。** 提交图、分支与标签、文件历史、差异、提交与修订、Shelf/Stash、推送与回滚、冲突及三路合并。
- **CVS。** 通过本机客户端检出，查看工作副本状态、文件 revision 历史和差异，执行提交、更新、取消及带确认和同目录备份的回滚。CVS 使用文件修订号，不显示 Git 专有操作。
- **显示语言。** 跟随 VS Code；英文默认，`zh`、`zh-cn`、`zh-tw` 使用简体中文，其它语言回退英文。更换 VS Code 显示语言并 Reload 后生效。

## Git 历史与合并

浏览提交和分支，检查变更文件，并通过右键菜单执行相应操作。以下截图展示已有 Git 功能，合并后的仓库工作面板布局见上方说明。

![Git 历史](./images/git-graph.png)

![提交右键菜单](./images/commit-context-menu.gif)

![冲突列表](./images/conflicts-list.png)

![三路合并](./images/three-way-merge.png)

## 安装

**扩展市场：** 在扩展视图搜索 **JetTortoise**，或执行：

```sh
code --install-extension jieyuexing.jettortoise
```

**从 VSIX：** 从 [Releases](https://github.com/jieyuexing/vscode-jettortoise-plugin/releases) 下载 `jettortoise-<version>.vsix`，或按下方开发步骤自行 `pnpm run vsce:package`，然后执行 **扩展：从 VSIX 安装…**，或：

```sh
code --install-extension release/jettortoise-<version>.vsix
```

Git 功能需要本机 Git 客户端；CVS 功能需要本机 `cvs` 客户端，未加入 PATH 时请设置 `jettortoise.cvsPath`。JetTortoise 不会自动下载客户端。

默认在受信任的当前工作区内递归发现 Git/CVS 仓库，不扫描窗口外的祖先，不跟随目录符号链接。仓库列表支持搜索、添加、重新扫描和恢复隐藏项；右键提供打开工作台、打开提交区、更新文件、刷新状态、复制路径和移除。列表保存于当前工作区，重开同一工作区后沿用。关闭 `jettortoise.autoDiscoverRepositories` 可停止自动发现，已有列表保留，仍可手动扫描。扫描取消或局部失败会标为未完成。

**更新此仓库文件** 对 Git 仅执行当前 upstream 的快进更新；有未提交内容、未保存编辑器、无 upstream、分离 HEAD、分叉或嵌套边界时拒绝。CVS 使用既有 update 和边界保护。更新不会切换当前标签。

选择工作区文件或历史文件即可预览 diff：Git 已暂存为 HEAD ↔ 暂存区，未暂存为暂存区 ↔ 磁盘；CVS 为 Entries/所选 revision ↔ 工作副本。每侧最多 2 MiB、20,000 行，二进制或超限内容可转到原生 diff。预览只读，未保存编辑会提示，文件正文不写入 webview 持久状态。

文件归属最近的真实仓库边界。未登记的子仓提供“添加并打开”；取消后不会退回父仓。父仓写操作不能跨入子仓，即使子仓已从列表移除。存在子仓且无法确认完整影响范围的操作会暂停，具体规则见[嵌套仓库说明](./docs/nested-repositories.md)。

在独立 VS Code 窗口打开子目录时，不会自动带入外层仓库。独立子仓可以添加；普通子目录则提示真实仓根在窗口之外，需要打开该仓根或将其添加为工作区文件夹。VS Code 自带 Git“源代码管理”视图使用另一套发现设置。

扩展身份为 `jieyuexing.jettortoise`，不导入旧 JetGit/JetCVS 命令与私有状态。命令、快捷键、CVS 配置及回退方法见[迁移说明](./docs/migration.md)。

## 安全与隐私

本次检查的源码未发现专用遥测、分析客户端或自动上传工作区的逻辑，仓库数据在本机处理。Git remote 操作和 CVS 服务端操作通过已安装客户端及其配置执行；Git 仍可能调用已配置的 hooks、filters 和凭据助手。CVS 使用已有客户端认证，并拒绝在仓库地址中内嵌密码。

Shelf/patch 文件和 CVS 回滚备份会留在磁盘中，复制和导入操作会使用系统剪贴板。各标签通过 VS Code 保存布局与历史偏好；Git 提交草稿仅保留在页面内存，CVS 提交草稿使用 webview state。仓库操作要求受信任的本地工作区。

输入、路径和确认边界已有专门回归检查。依赖风险、文件系统竞态限制及未覆盖的运行场景见[安全审查记录](./docs/security-review.md)。这些检查不构成无漏洞保证。

## 开发

```sh
git clone https://github.com/jieyuexing/vscode-jettortoise-plugin.git
cd vscode-jettortoise-plugin
pnpm install
(cd webview && pnpm install)
pnpm run build
```

使用 `pnpm run watch` 增量构建。在 VS Code 中打开本目录并按 **F5** 启动扩展开发宿主。`pnpm run check:l10n` 校验词典，`pnpm run test:headless` 运行不打开 VS Code 窗口的自动检查；真实窗口测试单独安排。打包与上架步骤见 [docs/release.md](./docs/release.md)。

Git 和 CVS 适配器均直接编译本仓 `packages/vcs-ui`。构建与运行不依赖旧 JetCVS 源目录，也不下载 UI 快照。

## 许可证

[MIT](./LICENSE)，保留原始版权声明。[CVS 迁入来源](./docs/cvs-import.md)记录了本地实现来源；安装包不包含 IntelliJ 集成层或协议库。

## 致谢

- [aotemj/jetbrains-git-graph](https://github.com/aotemj/jetbrains-git-graph)
- [zhyc9de/jet-git](https://github.com/zhyc9de/jet-git)
- [IntelliJ IDEA Icons](https://intellij-icons.jetbrains.design/) — Apache-2.0
