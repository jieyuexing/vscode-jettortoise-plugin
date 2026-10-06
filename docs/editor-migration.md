# 历史标签页与共享 UI 验证记录

> 本文保留先前独立 Commit 侧栏阶段的历史证据。当前四栏交付与产物摘要见 [四栏工作面板验证](./four-column-workbench.md)。

日期：2026-09-15。基线 commit：`32f7f5e4659f948cfbe2bf19412bfec0147c7f07`。本次工作基于已有文案、本地化和安全核查的未提交修改继续实施；未提交、推送、发布或升级 JetGit 依赖。

## 改动与使用

- 打包文件名为 `release/jetgit-0.4.17.vsix`，由 manifest 版本生成。扩展技术名仍为 `idea-like-git-graph`，publisher 为 `jetgit`，版本为 `0.4.17`。
- 状态栏 JetGit、命令面板“JetGit: 打开历史”与文件历史入口均打开中央编辑器标签页。首次在当前组打开，再次打开聚焦已有标签；移动标签后保持用户选择的组。
- 保留 `git-brains.gitLog` 页面类型及 `git-brains.gitLog.focus` 兼容命令。原有命令和快捷键保持；底部历史视图贡献按本次迁移要求移除。
- Commit 侧栏仍独立刷新；展开或收起不打开历史、不切换当前文件，也不关闭其他底部面板。
- 页面隐藏时保留上下文。Reload 后恢复文件、搜索、分支、作者、日期筛选，所选 revision ID 与列显示偏好，再读取 Git 数据。持久状态不保存提交文本、文件内容或 diff。冷启动文件历史通过 ready 消息交付；迟到的旧数据请求不会覆盖新筛选。

## 公共 UI 与同步

`packages/vcs-ui` 是公共来源，当前包含主题、历史/Commit 布局、菜单呈现、文件树、Tooltip、记录详情、展示类型和公共中英文文案。Git 图计算、store、bridge、命令和持久化仍在 JetGit 适配层。图标等依赖 VCS 含义的呈现由适配器作为 slot 传入，不在公共组件中执行 Git/CVS 操作。

JetCVS 从本仓生成固定副本到其 `vendor/vcs-ui`。两个插件分别从本仓构建，不在运行时读取相邻项目或下载公共 UI。

```bash
# 在 vscode-jetgit-plugin 目录执行
pnpm run sync:ui
pnpm run check:ui-sync
node scripts/check-vcs-ui.cjs
node scripts/check-ui-sync.cjs
```

同步收据记录来源 commit、逐文件 SHA-256 和集合摘要。来源仍有未提交修改时，以逐文件摘要识别实际快照，不能只用 commit 代替内容身份。消费者副本有手工修改或收据不一致时停止覆盖；修改应回到 JetGit 来源再同步。目标项目可用 `node scripts/sync-vcs-ui.cjs --target <product-root>` 显式指定。

JetCVS 的独立 Codex 主会话为 `01a0a2b5-1751-7dd3-af4d-6f10310f4a4e`；仅实施 `vscode-jetcvs-plugin`，IntelliJ CVS 参考仓保持只读。该主会话使用无项目入口创建，任务内命令固定到产品实际目录，没有把外层 `dsh-universe` 当成产品目录。

该任务已交付首个 `release/jetcvs-0.1.0.vsix`：107,914 字节、21 个 ZIP 条目，SHA-256 `bc3552c1f8a9def93049f9435e1ab61c2b29d8a610dce9677180ddb4ffa555fe`。本会话重算产物摘要、核对身份与共享 UI 版本均一致。JetCVS 报告 9/9 非 GUI 测试通过，包含真实本地 CVS、分支/tag、消息/路径负例和 DOM 恢复历史；实际共装和 GUI 验收仍未验证。具体功能与限制由 [JetCVS 验证记录](../../vscode-jetcvs-plugin/docs/validation.md)维护。

## 自动检查

- `pnpm exec vitest run`（webview）：10 个文件、41 项测试通过。覆盖语言回退与插值、菜单操作参数、文件历史竞态、状态恢复和刷新保持选择。竞态用移除保护的临时负向对照确认会失败。
- `pnpm run build` 与 `pnpm run vsce:package` 通过；保留既有 Biome 警告和大 bundle 提示。
- `check-l10n.cjs`：18 个清单 key、70 处 Host l10n 调用、240 个 webview key、287 个静态调用通过检查。
- `history-panel-check.cjs`：实际 Host 类搭配 VS Code API stub，验证单例、编辑器组、ready 队列、关闭清理、Reload 初始化以及 Commit 独立性。
- `host-ui-check.cjs`：实际六类 HTML/Host 代码搭配 API stub，验证语言注入、CSP、属性转义及中文确认按钮判断。
- `check-vcs-ui.cjs`、`check-ui-sync.cjs` 与实际目标 `--check`：公共代码没有后端导入，主题唯一来源、公共语言资源和消费者修改保护通过。

上述模拟与组件测试不替代真实 VS Code 窗口检查。实际宿主的检查结果和限制见 [editor-runtime-evidence.json](./editor-runtime-evidence.json)；产物清单、摘要及源码集合见 [editor-migration-evidence.json](./editor-migration-evidence.json)。

## 真实 VS Code 范围

最终包在 macOS arm64 / VS Code 1.137.0 的隔离 English 宿主中通过 Extension API 检查：实际 `vscode.env.language=en`，Commit 不自动打开历史，打开命令与兼容入口保持单例，首次当前组、移动后聚焦原组、关闭重开、冷文件历史打开标签，以及真实 Reload 后恢复一个历史标签均通过。

这些 API 检查不读取 webview DOM，不能证明可见文件筛选、revision 选择或滚动状态在真实界面中恢复；这部分只有组件/store 回归证据。简体、繁体、德语的本轮真实宿主检查未完成，两插件真实共装与视觉对比也未完成，不沿用旧包结果判定通过。

测试脚本未正确退出导致多个隔离 Code 实例堆积，用户反馈后已停止 GUI 测试。清理了本轮 12 个带 `jetgit-editor-runtime-` 临时 profile 的 Code 主进程和 2 个 runner，复查无匹配主进程；没有关闭用户日常窗口。脚本现要求显式 `--run-gui`，每轮等待对应实例退出后才允许下一轮，并在异常/中断时清理自身进程。修正后只检查语法与启动保护，未再次启动窗口，不能宣称清理修正经过真实多语言复跑。

## 安全与未覆盖范围

[安全与隐私检查](./security-review.md)的 P1 路径/消息参数问题仍未修复，安全发布验收仍未通过。本次没有修改 Git 命令实现、权限边界或依赖；临时仓库中的安全 smoke 仍能复现越界写/删除。9 月 12 日的依赖漏洞查询作为历史结果保留，不能解释为本次重新查询。

此次标签页和公共 UI 验证不构成完整网络捕获、全部 Git 操作回归或跨平台安全认证。实际运行、组件测试、结构检查与未验证项目分别记录，不以成功打包代替这些验收。
