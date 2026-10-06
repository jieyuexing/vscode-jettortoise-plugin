# JetGit / JetCVS 四栏工作面板验证

日期：2026-09-15。基线 commit：`32f7f5e4659f948cfbe2bf19412bfec0147c7f07`。本记录对应四栏交付，取代此前独立 Commit 侧栏布局的现行说明。保留此前未提交修改；没有提交、推送、发布、升级依赖或启动 VS Code 测试窗口。

## 使用与布局

JetGit 状态栏、“打开历史”、文件历史、“打开提交区”都进入同一个中央编辑器标签页。旧 `git-brains.gitLog.focus`、`git-brains.commitPanel.focus` 继续可用；提交入口展开第一栏并切回 Commit 子标签、聚焦消息框，保留历史筛选。JetCVS 对应 `jetcvs.openHistory`、`jetcvs.openCommit` 与旧 `jetcvs.commit.focus`，由既有独立任务实施。

| 第一栏 | 第二栏 | 第三栏 | 第四栏 |
| --- | --- | --- | --- |
| JetGit：完整 Commit / Shelf / Stash | 分支、标签 | 搜索、筛选、提交图 | 历史变更文件在上，提交详情在下 |
| JetCVS：文件勾选、消息、提交 | 工作副本文件 | 所选文件 revision 历史 | revision 详情与比较 |

第一、第二、第四栏默认 280 / 180 / 280 px，历史占余宽（最小 320 px）。拖动分隔线可调宽，也支持左右方向键；Home / End 到最小 / 最大宽度，Enter 折叠。提交区、导航、详情均可折叠，折叠栏提供恢复按钮。窄窗口临时收起详情、再收起导航；当前焦点所在栏或手动要求展开的栏受到保护。变宽后恢复用户布局，临时响应式折叠不保存为偏好。极窄窗口保留横向滚动，避免把提交操作压到不可用宽度。

独立 Commit 容器、视图、provider 已移除。完整提交区折叠后保持挂载；历史加载、报错和刷新只影响历史区域。工作区文件勾选和历史文件选择分属不同状态。提交消息下拉框以提交栏边界定位；Ctrl/Cmd+Enter 仅由提交文本框处理。

## 状态与共享来源

JetGit 由一个 webview state writer 保存 `version:2`、`history`、`layout`。兼容原 version 1 历史偏好；历史与布局交错更新不会覆盖另一分区。提交草稿和工作区选择沿用内存 store，未新增长期草稿持久化；成功提交仍按原行为清空消息。JetCVS 的已有草稿策略保留在其 `commit` 分区，详见消费者报告。

`packages/vcs-ui` 是公共唯一来源，snapshot 经 `scripts/sync-vcs-ui.cjs` 同步至 JetCVS 的 `vendor/vcs-ui`。本次共享摘要为 `cb9029581af454b2201483cef72afcbf3f003603d0dcacd40e35e93dd0d8e43b`。共享层只接收 slots、布局状态、文案与展示操作；无 Git/CVS/Node/VS Code 后端依赖。两仓均从本地副本独立打包。固定快照逐文件摘要和消费者手改保护已验证。

## 验证与边界

| 检查 | 结果与范围 |
| --- | --- |
| JetGit Vitest | 13 个文件、55 项通过。含既有图/菜单/语言回归和新增四栏顺序、鼠标/键盘调宽、折叠挂载、窄屏恢复、草稿与选择、快捷键边界、弹层定位、状态迁移及冷启动提交聚焦 |
| Host 生命周期 | API stub 检查通过：单例、当前编辑器组、冷文件历史和提交 focus 独立 ready 队列、关闭清理、反序列化恢复、无独立 Commit provider |
| JetGit 本地化 | 17 个 manifest key、70 处 Host l10n 调用、240 个 webview key / 288 处静态调用；共享 16 个中英文 key。zh/zh-cn/zh-tw 使用简体，其它回退英文 |
| Git 行为与原有身份 | 技术名、publisher、版本、原有 manifest command ID、快捷键、依赖、锁文件和构建配置保持；9 个内核/配置文件逐字节与本轮起点一致。仅新增 openCommit 并按计划移除视图贡献 |
| 共享检查 | 后端导入限制、本地化、临时快照、消费者修改拒绝及实际目标 --check 通过 |
| 构建与打包 | JetGit `pnpm run build` / `pnpm run vsce:package` 通过。既有 Biome 1 项 warning、4 项 info 和 Vite 大 chunk 提示保留 |
| JetCVS | 既有独立任务报告完整 10/10 无窗口测试、build/package 通过，覆盖真实临时 CVS、workspace 消息允许集合、字段/路径/能力负例、DOM 状态与 ready 聚焦；本任务重算包摘要和静态共存检查 |
| 包内资源 | 两包身份、nls/l10n 别名、webview 资源、许可证和开发材料排除通过；dist 与包内文件字节一致。Git 详情上下 Allotment 样式继续打入包 |
| 安全 smoke | 实际 GitService 在一次性临时仓库的本地 remote fetch/pull/push 通过；已知 workspace 外写入、删除仍可复现，安全验收未通过 |
| 真实 GUI | **未验证**。本轮未启动任何 Code/Electron/CUA 窗口；DOM 和 API stub 不替代真实视觉、拖拽、切换文件标签、语言、Reload 或同时安装验收 |

可复跑命令（全部无窗口）：

```sh
# JetGit 产品根
pnpm run check:l10n
node scripts/history-panel-check.cjs
node scripts/host-ui-check.cjs
node scripts/check-vcs-ui.cjs
node scripts/check-ui-sync.cjs
pnpm run check:ui-sync
(cd webview && pnpm exec vitest run)
pnpm run build
pnpm run vsce:package

# JetCVS 产品根
pnpm test
pnpm run package
node scripts/verify-package.mjs
```

测试环境为 macOS，pnpm 按 manifest 保持 10.18.2。Vitest 需要可解析 localhost 的本地环境；本次受限 sandbox 外执行的是纯无窗口测试进程。

## 安装包与内容身份

| 插件 | 产物 | 大小 | ZIP 条目 |
| --- | --- | ---: | ---: |
| JetGit | [jetgit-0.4.17.vsix](../release/jetgit-0.4.17.vsix) | 3,479,669 bytes | 26 |
| JetCVS | [jetcvs-0.1.0.vsix](../../vscode-jetcvs-plugin/release/jetcvs-0.1.0.vsix) | 98,774 bytes | 20 |

JetGit SHA-256：`db8b23f80630b6e1207b3e69d0f524d8ffbd7774edef47fe18ad19a30797a5ac`

JetCVS SHA-256：`dca0f44f52abe38fdadaac6c3f9c4c312666d26c546138cc9c9794a8a7185474`

最终 JetGit 显式源码/资源集合 178 个文件，SHA-256 `c587fea00c66e7814ef8e2ff18de43ea32900ce27617889a1fd96939ae1b0e71`。基线逐文件摘要、本轮差异清单、最终源码集合、包条目和验收分层记录见 [four-column-evidence.json](./four-column-evidence.json)。源码有未提交修改，不能仅用 HEAD 识别安装包；`release/` 继续被忽略。

## 未完成与既有问题

- 实际四栏观感、窗口拖拽和折叠、切换标签/关闭重开、实际显示语言与 Reload、两插件共装仍待用户之后单独安排窗口验收。
- JetGit 的 Host 消息/路径边界 P1 保留，[安全记录](./security-review.md)继续为未通过。本轮未重新查询依赖公告，9 月 12 日的结果保留原日期。
- 基线 manifest 中五个 `git-brains.commitPanel.*` 动作（refresh/commit/commitAndPush/shelve/unshelve）仍没有对应 Host command handler；本轮保留原 ID，未引入新的执行语义。提交区本身使用既有 bridge 操作，新“打开提交区”和旧 focus 入口已覆盖测试。
- JetCVS 远程连接方式、Windows、二进制/非 UTF-8 和大工作副本仍在其 [验证记录](../../vscode-jetcvs-plugin/docs/validation.md)中列为未覆盖，不因共享布局改变验收结论。
