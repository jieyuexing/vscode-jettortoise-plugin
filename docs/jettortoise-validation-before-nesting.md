# JetTortoise 合并验收记录

核查日期：2026-09-15。基线 commit `32f7f5e4659f948cfbe2bf19412bfec0147c7f07`；核查对象是其上保留既有修改并完成合并的本地工作树，不是已提交或已发布的远程版本。

**本地实现、无窗口测试与 VSIX 打包已完成。GitHub 改名已核实、本地 origin 已更新；真实 VS Code 窗口验收按约定未执行。**

## 实现范围

- 新身份 `jetgit.jettortoise`，版本 `0.4.17`，仅注册 12 个实际实现的新命令，统一 URI scheme；保留 Git/CVS 四栏工作流和显示语言策略。
- 仓库注册按类型和 canonical root 去重。每仓独立服务、消息分派、写队列、刷新、标签页及 diff authority。文件入口支持路径别名；通用入口只从工作区根和文件祖先发现仓库。
- Git / CVS 页面共享本仓 UI 源码。Git 草稿保留在页内存；CVS 草稿沿用 webview state。布局和历史分区保存；Host 保存新扩展已知仓库根以恢复 diff 上下文，并重新验证工作区归属。
- Git 增加运行时 schema、surface 与确认绑定、队列存活/信任检查、路径/Shelf/ref 边界。CVS 保留参数数组、取消、超时、路径与凭据错误脱敏；迟到的旧页面结果不会清空新页面草稿。
- 无旧命令兼容注册，不读取旧扩展私有状态。目录改名完整核对；[远程改名状态和用户迁移步骤](./migration.md)独立记录。

## 已执行检查

| 检查 | 结果与证据边界 |
| --- | --- |
| `pnpm run check:l10n` | 16 个 manifest key、126 处 Host l10n 调用、240 个 Git webview key、35 个 CVS key；公共 UI 另有 16 个 key。中英文键与占位符一致，中文别名、未知键和其它语言回退通过。 |
| `pnpm run test:headless` | 完整通过；包含下方当前生产源码的 Host seam 测试及真实临时仓库测试。不是实际 VS Code 运行。 |
| Webview Vitest | 14 个测试文件、58 项测试通过。覆盖布局、折叠与宽度、状态分区、草稿、菜单、语言、慢加载/失败和选择隔离；DOM 并不证明真实窗口观感。 |
| Git 安全 | 15 项负例及 index-stage、内部链接回滚检查；外部 write/delete sentinel 未变。合法 Unicode、空格、前导连字符文件、本地 remote、Shelf 和三路合并内容通过。 |
| Router | 前端 126 处显式请求的字段及 surface 合同核对通过。非法类型、额外字段、越权 surface、伪造 cwd、路径穿越拒绝；中文确认结果、取消、排队失效、页面关闭、确认等待期间关闭及 undefined 返回只执行一次通过。 |
| 仓库注册 | 12 个检查项：canonical 别名、两 Git 根隔离、CVS 发现、非法根、未信任/虚拟/移除工作区、伪造 authority、跨仓 diff 拒绝及保存的 diff 上下文恢复。 |
| 实际 Host + 模拟 VS Code API | 两个临时 Git 仓库和一个真实本地 CVS 工作副本同时建页；12 命令覆盖、重复打开、ready 队列、各仓提交文件列表/刷新、确认取消、关闭重开和监听清理通过；Git 与 CVS Host 实际提交成功，各自操作没有改变其它仓的历史；恶意路径被拒绝。 |
| 实际 CVS CLI | 2 项综合测试，通过本地 init/import/checkout、Unicode/空格路径、status/log/revision/diff、commit、第二工作副本 update、备份 rollback，以及参数、符号链接、取消负例。 |
| HTML / 公共 UI | 6 个 mode 的 Host 语言注入、恶意属性转义、CSP；共享组件没有 Node、VS Code 或内核依赖。 |
| GitHub 改名 / origin | 2026-09-15：新仓名 `jieyuexing/vscode-jettortoise-plugin`，仓库 ID `1366444411` 不变；本地 fetch/push origin 均为新 SSH 地址。`git ls-remote --symref origin HEAD` 通过，默认分支 main、远程 HEAD `32f7f5e4659f948cfbe2bf19412bfec0147c7f07`。未拉取或推送。 |
| build / package | 新目录独立构建和 `pnpm run vsce:package` 通过；保留依赖版本与 `release/` ignore。Vite 仍报告已有的大 bundle 提示，Biome 有风格建议，无阻断错误。 |
| 包内容 | 26 项，含清单、nls/l10n 及中文别名、Host 与 webview、图片和 MIT；无源码、脚本、vendor、开发材料、旧 VSIX 或 source map。 |

环境：macOS arm64，Node `v23.11.0`，Git `2.50.1 (Apple Git-155)`，CVS `1.12.13`，pnpm `10.18.2`。项目依赖版本和锁文件未升级。使用可写临时工具目录中的同版本 pnpm 解决 Corepack 缓存权限问题；Vitest 在默认沙箱无法解析 localhost，获准在沙箱外运行无窗口测试。依赖审计也只向公共 npm registry 发送公开包名和版本。

完整输出见 [headless.log](./evidence/headless.log)、[build.log](./evidence/build.log)、[package.log](./evidence/package.log)。历史 GUI 脚本和原 `security-smoke.cjs` 是旧身份/P1 复现工具，不属于本轮 headless 验收；不要把旧工具结果用于新版本判定。

## 交付物

- `release/jettortoise-0.4.17.vsix`，3,502,346 bytes。
- VSIX SHA-256：`88982d9cf3576fbf2fbcecba5900d417f982872762e04a167df7103140920d22`。
- 210 个源码/资源/验证脚本输入集合 SHA-256：`42daffa515e77a1cfa0727cd5e6b29ca7f7f579029f615a8705c2b4fcb16011b`。
- 文件清单、算法及包内条目：[jettortoise-evidence.json](./jettortoise-evidence.json)。报告排除在包与集合摘要之外，避免自引用。

## 尚未验收

- 真实 VS Code 窗口、可视布局、拖拽/并排、真实 Reload、扩展切换/共装与键盘焦点；本轮没有启动 VS Code 测试窗口。
- 系统级网络捕获、Windows/Linux、远程/虚拟扩展宿主、CVS pserver/真实服务器认证、hooks/filters/credential helper 环境。
- 安全结论、依赖风险及文件系统竞态限制以[安全审查](./security-review.md)为准，不以构建通过代替安全验收。
