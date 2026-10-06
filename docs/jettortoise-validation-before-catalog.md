# JetTortoise 嵌套仓库验收记录

日期：2026-09-15。基线 commit `32f7f5e4659f948cfbe2bf19412bfec0147c7f07`；对象为保留既有未提交修改的本地工作树。上阶段记录保存在 [合并验收历史](./jettortoise-validation-before-nesting.md)。

**显式登记、嵌套边界及独立子窗口仓根限制已完成本地实现、无窗口回归和 VSIX 打包。真实 VS Code 窗口、安装与 Reload 未执行。**

## 本轮行为

- 当前工作区通过 `jettortoise.addRepository` / `jettortoise.removeRepository` 显式维护登记，共 14 个实际实现命令。旧仓根只作为确认候选，文件入口遵循最近真实边界；取消添加子仓不会落入父仓。
- 已登记仓库按目录层级选择，每仓独立四栏标签和上下文。移除登记不删除文件、既有页面或已保存状态；恢复时取消登记可保留页面，但拒绝操作。无效恢复目标的限制见[嵌套说明](./nested-repositories.md)。
- 独立打开子目录窗口时只允许窗口工作区之内的仓根。独立子仓正常候选；普通子目录不能静默使用外层仓。该规则针对 JetTortoise；VS Code 自带 Git 视图和用户设置未修改。
- 父仓待提交文件排除子仓并显示边界入口；Git 历史仍属于原仓。全部暂存只处理授权文件；提交前检查完整索引，拒绝重叠且不取消暂存。
- Host 与内核重新检查路径和子仓。全仓操作影响范围不确定时拒绝；CVS 连续子目录与独立 checkout 区分，独立子仓不进入父清单。Git 保存事件只刷新所属仓，精确跟踪重叠文件的父仓例外。
- 版本、身份、命名、依赖锁文件和 release 忽略规则不变。原 JetCVS 起点 67 项文件逐一复核未变。

## 已执行检查

| 检查 | 结果与证据边界 |
| --- | --- |
| 登记及窗口范围 | `nested-registry-check.cjs` 22 个检查项：三层 Git、Git 内 CVS、层级、别名、未登记/取消、移除重加、旧状态候选、取消恢复保留页面但拒绝操作、伪造/过期边界 ID、物理根替换、独立子窗口拒绝祖先。VS Code API 为模拟。 |
| Git 嵌套 | `git-nesting-check.cjs` 15 个检查项：父子独立提交、合法父文件、全部暂存跳过子仓、终端预暂存和未变索引重叠拒绝、写入/删除 sentinel、子仓链接指回父仓、选中文件 Shelf、Shelf 存储子仓读/导出/删除拒绝、全仓 checkout 拒绝。使用真实临时 Git。 |
| CVS 嵌套 | `cvs-nesting-check.mjs` 2 项综合测试：连续目录、同源独立 checkout、异源 checkout、CVS 内 Git、父子独立文件操作、递归 update 拒绝。使用真实本地 CVS；没有远程服务器。 |
| 保存事件归属 | `nested-watcher-check.cjs` 5 项检查：子仓独立、canonical 别名、父仓普通文件、精确索引重叠、同级/外部路径静默。真实 Git + 模拟保存事件。 |
| 实际 Host 分派 | 两个临时 Git 仓和一个本地 CVS 工作副本、14 命令、显式添加、独立提交和刷新、单例/ready/关闭重开通过。额外验证 Host 直接删除子仓拒绝、提交在暂存前拒绝、确认期间新增子仓拒绝。生产 Host + 模拟 VS Code API，不是实际窗口。 |
| 既有安全和隔离回归 | Git 15 项安全负例及 index-stage/内部 symlink 回滚通过；Router 类型/字段/surface/确认/队列检查通过；注册与 URI 隔离原集合 14 项通过。外部 sentinel 未变。 |
| CVS 原内核回归 | 2 项综合测试通过：init/import/checkout、status/log/revision/diff、commit、第二副本 update、backup rollback、参数/symlink/取消。保留原 `symlink` 错误合同。 |
| 本地化与消息合同 | manifest 18 key、Host 141 处 l10n 调用、Git webview 240 key、CVS 35 key、公共 UI 19 key；前端 127 处字面量请求字段/surface 核对。英文、简体/繁体别名、其它语言回退通过。 |
| Webview | 15 个文件、63 项 Vitest 通过；含四栏状态/布局、草稿、慢加载/错误、菜单、语言和新增子仓提示按钮/HTML 文本转义。DOM 结果不证明真实窗口观感。 |
| HTML 和公共依赖边界 | 6 mode 的 Host 数据与语言转义/CSP 通过；公共 UI 无 Node、VS Code 或内核导入。 |
| 构建与打包 | `pnpm run check:l10n`、`pnpm run test:headless`、`pnpm run build`、`pnpm run vsce:package` 通过。没有启动 GUI。保留已有 Vite 大 bundle 提示与 Biome 非阻断建议。 |
| 包及材料 | 26 项 VSIX 内容与当前 dist 逐字核对，MIT 保留、nls/l10n 中文别名齐全；无源码、脚本、docs、vendor、node_modules、source map 或旧包。README 源截图均为存在的本地相对路径；vsce 对包内主 README 保留默认的当前 GitHub 链接改写。 |

环境：macOS arm64，Node `v23.11.0`，Git `2.50.1 (Apple Git-155)`，CVS `1.12.13`，pnpm `10.18.2`。使用 `/private/tmp/jetgit-tools/bin` 中的同版本 pnpm；Vitest 的 localhost 解析限制通过获准的沙箱外无窗口执行解决，没有升级依赖。

完整日志：[headless](./evidence/nested-headless.log)、[l10n](./evidence/nested-l10n.log)、[build](./evidence/nested-build.log)、[package](./evidence/nested-package.log)。修复前对照：[全部暂存](./evidence/nested-git-before.log)、[保存刷新](./evidence/nested-watcher-before.log)、[子仓链接](./evidence/nested-link-before.log)、[完整索引](./evidence/nested-index-before.log)。历史 GUI 脚本不属于此次执行集合。

## 产物与版本绑定

- `release/jettortoise-0.4.17.vsix`，3,509,083 bytes。
- VSIX SHA-256：`9d900785b206f64079a1ac2072e87dc633ecdab41ce3e8e9d990dc2e22afc241`。
- 219 个源码/资源/构建及验证输入 SHA-256：`9833075b7109c9d72bae44938711691d820de15cd4e09f1df90a87b36f4f493a`。
- 清单与摘要算法：[jettortoise-evidence.json](./jettortoise-evidence.json)。本轮起点：[before-nesting-baseline.json](./evidence/before-nesting-baseline.json)。没有删除该起点清单内的文件。
- 上一版 JetTortoise 包保留在 `release/archive/jettortoise-before-nesting-20260915.vsix`，摘要仍为 `88982d9cf3576fbf2fbcecba5900d417f982872762e04a167df7103140920d22`。旧 JetGit 包目前不在产品 release 目录，不能把历史迁移时的存在记录当成当前回退包已核实。旧 JetCVS 源仓仍保留。

## 未验证与风险

真实 VS Code 窗口、层级选择器观感、拖拽/并排、实际 Reload、安装切换、共装与键盘焦点均未执行。用户报告的外层仓库显示若来自内置 Git 侧栏，需要按该扩展单独定位；本次只验证 JetTortoise 的窗口边界。

没有系统级网络捕获，未验证 Windows/Linux、真实 CVS 服务器认证、用户 hooks/filters/credential helper、submodule/worktree 专用管理和全部本地文件系统竞态。5,000 目录预检限额超出时会拒绝操作，不宣称超大仓树已经完整扫描。安全风险与依赖漏洞仍按[安全审查](./security-review.md)保留；构建通过不等于安全发布验收通过。
