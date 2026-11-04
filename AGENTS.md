# JetTortoise

本目录只拥有 VS Code 扩展 `jieyuexing.jettortoise`；工程说明见同目录 `CLAUDE.md`。执行前同时读取总仓的 `AGENTS.md`，任务书决定本轮可改范围和提交、推送权限。

## 路由

| 触发条件 | 命令 | 合同文档 |
| --- | --- | --- |
| Commit 分组、多仓 Git/CVS、路径提交、刷新与边界回归 | `pnpm run test:headless` | `CLAUDE.md`「交互与边界」「检查」；入口 `scripts/headless-check.cjs` |
| 工程右键资源命令（更新、提交、历史） | `pnpm run test:headless` | `CLAUDE.md`「工程资源命令」；入口 `src/extension.ts` 与 `src/repositories/manager.ts` |
| 大工作区首屏分批、保存监听、本地刷新、扫描暂停与本地重试、全局网络并发、提交／日志虚拟文件树、主题图标与自然排序 | `pnpm run test:headless` | `CLAUDE.md`「大工作区刷新与渲染」「扫描暂停」「大工作区首屏与保存监听」；入口 `scripts/repository-performance-check.cjs` 与 `webview/src/commit/commit-ui.test.tsx` |
| CVS 根右键按需同步、移除、未同步提示 | `pnpm run test:headless` | `CLAUDE.md`「CVS 按需同步」；入口 `src/repositories/manager.ts` 与既有性能／UI 回归 |
| 修订内容编码、CVS 更新冲突通知、新签出工作副本发现 | `pnpm run test:headless` | `CLAUDE.md`「环节 7 缺口」；入口 `scripts/vcs-host-check.cjs` |
| 构建与打包候选 | `pnpm run check-types`、`pnpm run lint`、`pnpm run build`、`pnpm run vsce:package` | `CLAUDE.md`「检查」 |
| 中文界面、翻译覆盖与 Commit 列表密度 | `pnpm run test:headless`（包含 `scripts/check-l10n.cjs`） | `CLAUDE.md`「本地化与列表密度」 |

新检查并入现有 headless 入口，不创建独立运行机制。检查只用临时仓库与模拟 VS Code API；不启动 GUI，不接入公司服务。版本只在 `package.json` 定义，同时更新 `CHANGELOG.md`。
