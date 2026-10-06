# JetTortoise 仓库列表与 diff 工作台验收记录

日期：2026-09-16。基线 commit `32f7f5e4659f948cfbe2bf19412bfec0147c7f07`；本轮在保留既有未提交修改的工作树上实施。上一阶段报告保存在 [嵌套仓库验收历史](./jettortoise-validation-before-catalog.md)。

**仓库列表、默认递归发现、工作区保存恢复、定向更新和上置只读 diff 已完成本地实现、无窗口回归与 VSIX 打包。实际 VS Code 窗口、安装、Reload 和关闭重开仍未验收。**

## 本轮行为

- 当前工作区内默认递归发现所有层级的 Git/CVS 元数据，不进入管理目录、不跟随目录符号链接、不向窗口外祖先扩展。扫描有有限并发、增量结果和取消；局部失败标记未完成，不据此删除记录。发现不调用客户端、访问 remote 或提前建立所有 session。
- 原有 `workspaceState.repositoryRegistrations` 升级为 v2，保留 ID，新增自动/手动来源、隐藏项和扫描状态。重建时校验已保存条目；关闭自动扫描也会保留并标记暂不可用的手动仓库。隐藏后不被扫描加回；恢复失败后仍可以再次隐藏。没有另建登记存储。
- 每仓仍为独立标签。第一栏展示仓库列表及当前仓导航，第二栏提交，右上 diff，右下历史/详情。默认宽度 220 / 280 / 260 px，diff 高度 55%；用户尺寸和折叠独立保存，窄窗口临时折叠不覆盖偏好，diff 最大化保留其它区域挂载。
- 右键更新仅操作目标仓的写队列，不切换当前标签。Git 使用固定快进 pull，执行时检查脏状态、未保存编辑器、upstream、detached HEAD、进行中操作、信任、身份及子仓。CVS 保留原有队列、取消、超时和错误脱敏，更新失败会传回列表。
- Git 暂存为 HEAD ↔ index，未暂存为 index ↔ 磁盘；历史处理新增、删除、重命名和范围。CVS 为 Entries/所选 revision ↔ 磁盘。原生与内嵌入口共用解析，CVS stdout 与诊断分流。Git 路径使用 NUL 输出解析，避免中文、箭头文本与组合状态误读。
- 最近一次明确文件选择控制 diff；迟到响应丢弃，刷新不换源或清空消息。每页状态仅保存选择引用和模式，不保存正文；每侧 2 MiB / 20,000 行，超限、二进制、非法 UTF-8 或复杂比较提供原生入口。
- 身份、版本、依赖、锁文件与 release 忽略规则不变。没有提交、推送、发布、安装或启动 VS Code 测试窗口。

## 已执行检查

| 检查 | 结果与证据边界 |
| --- | --- |
| 管理/比较消息 | `workbench-channel-check.cjs` 16 项：严格允许集合、额外字段/cwd/未知 ID 形状拒绝、页面绑定与迟到结果保护。普通 Git/CVS 消息仍保留原安全合同。 |
| 递归发现 | `catalog-discovery-check.cjs` 14 项：深层 Git/CVS、gitfile、被忽略目录、连续 CVS/独立 checkout、符号链接跳过、工作区范围、取消及权限错误。只读元数据，无 Git/CVS CLI。 |
| 登记保存恢复 | `catalog-registry-check.cjs` 10 项：v1 → v2、相同 ID、多个工作区状态隔离、重建、隐藏/恢复、取消保留、不可用手动项、物理替换拒绝。模拟 workspaceState，不代替真实关窗重开。 |
| Git 更新 | `catalog-update-check.cjs` 14 项，真实临时 bare remote：快进成功、脏工作区/索引、detached HEAD、无 upstream、分叉、进行中操作、子仓、第二次校验失败及取消。固定参数经源码核对；未保存文档和跨仓分派由 Host 检查覆盖。 |
| 比较解析 | `comparison-check.cjs` 57 项，真实临时 Git/CVS：暂存/未暂存、部分暂存、增删、重命名、范围、父仓历史、特殊路径和组合状态、空侧、正文分流、二进制、大小/行数/解码限制及跨边界拒绝。 |
| 嵌套与安全回归 | Git 嵌套 15 项、CVS 嵌套 2 项综合、登记/窗口边界 22 项、保存路由 5 项、Git 安全 15 项负例、原注册/URI 隔离 14 项；Router schema/surface/确认/队列检查和 127 处前端请求合同通过。外部 sentinel 未变。 |
| 生产 Host + 模拟 VS Code | 16 个实际命令、两个 Git 仓及一个 CVS 工作副本：独立提交/刷新/事件、单例、ready、关闭重开监听、确认取消、子仓删除/确认期间改变边界等通过。另从 A 页向 B 发起真实本地快进，B 行反馈成功且未聚焦其它标签；未保存文档使用路径别名，拒绝更新且磁盘未变。没有创建真实窗口。 |
| CVS 原操作 | 2 项真实本地 CVS 综合测试：checkout/status/log/content/diff/commit/update/rollback，参数、symlink、取消。真实 CVS 服务器认证未覆盖。 |
| Webview | 17 文件、70 项 Vitest：目录列表菜单/搜索、布局和 v1 状态迁移、最大化挂载保留、diff 模式/持久引用、迟到响应、恶意文本、草稿、菜单与语言回退。DOM 通过不代表真实视觉、焦点或拖拽手感通过。 |
| 本地化/资源边界 | manifest 21 key、Host 167 处 l10n 调用、Git webview 278 key（静态调用 305）、CVS 35 key、公共 UI 19 key。6 mode 的 Host 属性/语言转义及 CSP、公共 UI 12 源文件的无内核导入检查通过。en 默认，zh/zh-cn/zh-tw 简体，其它英文。 |
| 构建和打包 | `pnpm run check:l10n`、`pnpm run test:headless`、`pnpm run build`、`pnpm run vsce:package` 通过。保留既有 Vite 大 bundle 提示及 Biome 非阻断建议，未升级依赖。 |
| 包与保留性 | VSIX 26 项，dist 与本地字节一致；MIT、nls/l10n 别名齐全，无旧 VSIX、vendor、源码、docs、测试脚本、node_modules 或 source map。源码 README 截图均为存在的本地相对路径，包内主 README 仍使用 vsce 默认 GitHub 链接改写。旧 VSIX 摘要保持；旧 JetCVS 源目录当前缺失，67 项来源文件仅有历史核对记录，本轮无法复核。 |

环境：macOS arm64，Node `v23.11.0`，Git `2.50.1 (Apple Git-155)`，CVS `1.12.13`，pnpm `10.18.2`。同版本 pnpm 位于 `/private/tmp/jetgit-tools/bin`。Vitest 的 localhost 解析限制通过获准的沙箱外无窗口执行解决；没有启动编辑器。

完整日志：[headless](./evidence/catalog-headless.log)、[l10n](./evidence/catalog-l10n.log)、[build](./evidence/catalog-build.log)、[package](./evidence/catalog-package.log)。未保存编辑路径别名漏判的同入口修复前失败保留于 [对照日志](./evidence/catalog-dirty-editor-before.log)。界面静态检测仅有两个误报，均指向测试中的恶意 `<img>` 文本 fixture，见 [检测输出](./evidence/catalog-ui-detector.json)；它不是渲染验收。

## 产物与绑定

- `release/jettortoise-0.4.17.vsix`，3,528,541 bytes。
- VSIX SHA-256：`68e9a281a2d9c3122b55717f4eecf2ae9990f89140452471061f2e12986ca53b`。
- 235 个源码、资源、构建及验证输入 SHA-256：`8f58a5de380d5e8440db403952071a672af5e9df5c53a70d5a561267b8d5b1a0`。
- 摘要算法、文件与差异清单：[jettortoise-evidence.json](./jettortoise-evidence.json)；本轮起点 [before-catalog-baseline.json](./evidence/before-catalog-baseline.json)。起点 263 项文件未丢失，新增与修改分别记录。没有暂存区或 HEAD 变更。
- 本轮之前的包保留在 `release/archive/jettortoise-before-catalog-20260916.vsix`，SHA-256 `9d900785b206f64079a1ac2072e87dc633ecdab41ce3e8e9d990dc2e22afc241`。更早包继续保留；旧 JetCVS 源目录当前不在原路径，此轮未写入或删除该目录，保留性未能重新验证；旧 JetGit 包在本轮起点已不在 release 目录，未将它算作已核实的回退包。

## 未验证与风险

真实 VS Code 中的列表观感、菜单位置、拖拽/并排、焦点、快捷键、实际 Reload、关闭重开持久化、语言显示和安装切换均未执行。子窗口不借用窗口外父仓的 Host 规则有回归；VS Code 自带 Git“源代码管理”视图仍由内置扩展管理，未改用户设置。

未覆盖系统级网络捕获、Windows/Linux、真实 CVS 服务器认证、全部 hooks/filters/credential helper、submodule/worktree 专门管理及所有文件系统竞态。发现无深度上限但不承诺超大目录树的完成时间；全仓写操作预检仍保留 5,000 目录和 CVS 清单 2,000 项限制，超限拒绝。安全与依赖风险见 [安全记录](./security-review.md)，构建和本地回归不等于整体安全发布验收通过。
