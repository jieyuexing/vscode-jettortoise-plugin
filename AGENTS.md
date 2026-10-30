# JetTortoise

本目录只拥有 VS Code 扩展 `jieyuexing.jettortoise`；工程说明见同目录 `CLAUDE.md`。执行前同时读取总仓的 `AGENTS.md`，任务书决定本轮可改范围和提交、推送权限。

## 路由

| 触发条件 | 命令 | 合同文档 |
| --- | --- | --- |
| Commit 分组、多仓 Git/CVS、路径提交、刷新与边界回归 | `pnpm run test:headless` | `CLAUDE.md`「交互与边界」「检查」；入口 `scripts/headless-check.cjs` |
| 构建与打包候选 | `pnpm run check-types`、`pnpm run lint`、`pnpm run build`、`pnpm run vsce:package` | `CLAUDE.md`「检查」 |
| 中文界面、翻译覆盖与 Commit 列表密度 | `pnpm run test:headless`（包含 `scripts/check-l10n.cjs`） | `CLAUDE.md`「本地化与列表密度」 |

新检查并入现有 headless 入口，不创建独立运行机制。检查只用临时仓库与模拟 VS Code API；不启动 GUI，不接入公司服务。版本只在 `package.json` 定义，同时更新 `CHANGELOG.md`。
