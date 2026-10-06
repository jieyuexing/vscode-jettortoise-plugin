# JetGit 验证记录

后续的产物命名、历史标签页与共享 UI 改动见 [2026-09-15 验证记录](./editor-migration.md)及其绑定的新 VSIX 摘要。以下保留 2026-09-12 文案与 i18n 阶段的检查结果，不能直接作为新包的运行验收。

日期：2026-09-12。基线：`32f7f5e4659f948cfbe2bf19412bfec0147c7f07`。未提交、推送或发布。

## 构建与资源

- 使用锁定的 pnpm 10.18.2；Corepack 缓存设到 `/private/tmp/jetgit-corepack`，未更改项目依赖版本或锁文件。
- 文案阶段与最终 `pnpm run build` 均通过；`pnpm run vsce:package` 通过。
- `pnpm run check:l10n` 通过：19 个清单 key、70 处 Host l10n 调用、240 个 webview key、286 个静态 t 调用；key、占位符和别名一致，未发现直接英文 JSX/可见属性残留。
- 英文与中文 README 各 5 张截图，均使用存在的相对路径；旧外部标识只留在致谢、MIT 版权或 CHANGELOG 历史。
- 版本 0.4.17、技术名、原有 git-brains 标识及快捷键与改前逐项一致。Git 参数与持久化默认名称保持原文；原始 Git 错误不翻译。
- 最终 VSIX 为 `release/idea-like-git-graph-0.4.17.vsix`，26 项、3,473,780 字节，已在隔离扩展目录成功安装。完整摘要与文件清单见 [validation-evidence.json](./validation-evidence.json)。

## 自动检查

- `pnpm --dir webview test`：6 个文件、33 项测试通过，包含语言回退、参数插值、未知 key、Push/CreateBranch 对话框与 Shelf 右键操作数据不变。
- `node scripts/host-ui-check.cjs`：实际 HTML 与 Host 代码的六种 mode、恶意属性转义、CSP、未知命令翻译、中文回滚／删除确认比较通过。此项使用 API stub。
- `node scripts/security-smoke.cjs`：临时本地 remote 的 fetch/pull/push 可执行；越界写／删风险可复现。这是风险证据，不是安全通过。
- `git diff --check` 通过。原有非空断言与大 bundle 提示保留，不属于本次无关重构范围。

## 真实 VS Code

使用 VS Code 1.137.0 arm64、隔离 user-data/extensions 目录、官方语言包与一次性冲突仓库。测试无真实业务凭据。

- English、简体、繁体、德语的清单与官方 Host l10n 加载均验证；首次新 profile 生成语言包缓存后重启，只有实际 env.language 匹配才算对应语言验证。
- 在真实 webview 内层文档检查 Git Log、Commit、Push、冲突和三路合并；英文显示英文，简体／繁体显示简体，德语回退英文。最终 VSIX 解包代码也完成 English、繁体和德语检查。
- 简体下通过真实 Commit 工具栏打开 Rollback 预览，检查中文文案后未执行回滚。实际 Git Log 提交右键显示复制提交哈希、拣选、检出修订版本、重置、还原、分支和标签操作。
- 分别启动不同显示语言的隔离宿主验证了重载后的加载；未在日常用户 profile 操作 Configure Display Language。没有把主机语言或测试字典注入伪装成 VS Code 显示语言。
- 发现原有 5 个 commitPanel 清单命令未注册；测试显式记录该基线，未补实现。详情见机器证据。

## 安全边界

[安全与隐私检查](./security-review.md)仍未通过发布验收：P1 路径／消息参数问题未修，开发工具依赖存在已知漏洞。没有系统级完整流量捕获、全部恶意 patch/符号链接组合或真实 credential helper/hooks/filter 验证。webview 资源时序中只观察到 VS Code 本地映射的 CSS 与 JS，不据此宣称没有任何联网或泄露风险。
