# JetGit 安全与隐私审查记录

## 结论状态

**未通过安全发布验收。** 本记录是一次面向源码与本地隔离实验的基线审查，不是独立安全审计或无风险保证。

## 2026-09-15 四栏工作面板复核（当前交付）

本次包 `release/jetgit-0.4.17.vsix`，3,479,669 bytes、26 个 ZIP 条目；SHA-256 `db8b23f80630b6e1207b3e69d0f524d8ffbd7774edef47fe18ad19a30797a5ac`。最终 178 项源码/资源集合摘要为 `c587fea00c66e7814ef8e2ff18de43ea32900ce27617889a1fd96939ae1b0e71`。实际文件清单和起点差异见 [four-column-evidence.json](./four-column-evidence.json)。下方历史包摘要保持为当时记录。

- 独立 Commit 区合入中央四栏；新状态只保存历史和布局偏好，不额外长期保存 JetGit 提交草稿。历史搜索词、路径和选择仍可能属于敏感本地元数据，保存边界不因折叠而改变。
- 新布局、状态层和入口未新增联网库、远程下载、HTML 执行或后端导入；文案仍以 React 文本显示。弹层只是本地位置计算。最终包不包含源码、同步脚本、vendor、测试目录或旧 VSIX。
- 本轮起点比对确认 Git 内核、依赖、锁文件及构建配置未变。新增 Host focus 事件与文件历史使用独立 ready 队列；现有 MessageRouter 的输入校验缺口没有被修复或放宽为新的安全保证。
- 再次运行实际 GitService 的临时本地安全 smoke，越界写入/删除仍复现；本地 bare remote fetch/pull/push 通过。**P1 未修，安全发布验收仍未通过。**
- JetGit 55 项组件/状态测试及 Host stub、本地化、build/package 通过；JetCVS 由独立任务核查合并 workspace surface、参数/路径/能力拒绝。各自证据不互相代替。
- 本轮没有启动真实 VS Code 窗口，没有进行运行时网络捕获或依赖公告重查。真实布局、语言、Reload、共装、跨平台及原未覆盖安全路径继续未验证，详见 [四栏验收记录](./four-column-workbench.md)。

## 2026-09-15 历史标签页与共享 UI 复核

当时交付包为 `release/jetgit-0.4.17.vsix`，26 项、3,476,335 字节，SHA-256：`b4a84d965d796075d9f5dddaf426786709f836d62b76f04767fb79984dd41297`。名称、版本与 Git 行为按原约束保留；历史页迁到编辑器区，公共组件由本地 `packages/vcs-ui` 编译进入包。当前源码/资源集合摘要为 `e8afe866b4dfe4637740b9b993169e9378af504b0c52d927042ce49ce46ed6ed`（157 个文件；具体集合与算法见 [editor-migration-evidence.json](./editor-migration-evidence.json)）。

- 本次新增的历史页面生命周期、持久状态、共享 UI 源码与最终包已检查。未发现新增 HTTP/WebSocket、动态下载或 HTML 执行入口；公共组件不导入 Node、VS Code 或 Git/CVS 内核。
- 历史偏好通过 VS Code webview state 保存文件/分支/作者/搜索/日期筛选、所选 revision ID 和列显示偏好，可能包含本地路径和用户输入的搜索词；不保存文件、diff 或提交正文。该状态由 VS Code 在本机管理。
- 提交文本的链接与邮箱呈现迁入公共 `RevisionInfo`，仍使用 React 文本、受限 HTTP(S) linkification 及 `noopener noreferrer`，点击外部链接的边界不变。
- 包内已复核 nls/l10n 别名、原 MIT 版权和构建资源；没有源码、脚本、开发目录、共享源副本或旧 VSIX。脚本只在本地构建时同步文件，插件运行时不访问另一产品仓。
- 本次重新运行的实际 `GitService` 临时仓库 smoke 仍能复现越界写/删除，同时受控本地 remote 的 fetch/pull/push 通过。**既有 P1 问题仍未修，安全发布状态没有改善为通过。**
- 41 项组件/状态测试、Host API stub 检查、构建与打包通过；真实编辑器生命周期证据及其限制独立记录在 [历史标签页验证记录](./editor-migration.md)。没有把这些结果等同于运行时无联网或完整安全认证。
- 依赖与锁文件未改。本次未重新查询漏洞数据库，下面 2026-09-12 的依赖结果保留其原日期；未覆盖的网络、hooks、filters、凭据助手、恶意 patch 与跨平台场景继续未验证。

## 2026-09-12 文案与本地化阶段基线

审查在扩展基线 `32f7f5e4659f948cfbe2bf19412bfec0147c7f07`（2026-06-23）上开始。开始时工作区已有 `.gitignore` 和 `package.json` 的未提交修改；随后对文案与本地化后的源码、HTML 转义与确认操作、最终 VSIX 内容及隔离 VS Code 加载完成复核。复核日期为 2026-09-12；未修复的 P1 问题仍成立。

| 项目 | 结果 |
| --- | --- |
| 最终 VSIX | `release/idea-like-git-graph-0.4.17.vsix`；26 个文件，3473780 字节；publisher `jetgit`，version `0.4.17`。 |
| SHA-256 | `b06e0eaed4ce1f3d28eb9cd1d150f6113a3d56bc05c0614a3fe895cfe421a829` |
| 依赖审计 | 2026-09-12 通过公开 npm registry 执行的全依赖审计：根工作区 66 项（low 4、moderate 22、high 39、critical 1），webview 38 项（low 4、moderate 15、high 19）。这两份结果按各自锁文件统计，不能合并为 104 个独立漏洞。两处 `--prod` 审计均为 0 项（根：2 个生产依赖；webview：62 个生产依赖）。 |
| 未解决源码问题 | P1：webview 消息参数未在 Host 侧校验，存在路径越界和 Git 参数语义改变的防御缺口。 |

## 已核实的数据流

### 联网、遥测与凭据

- 在 `src/` 和 `webview/src/` 中，未发现扩展直接使用 HTTP 客户端、WebSocket、遥测/分析 SDK、自动更新器或动态下载代码。webview HTML 的 CSP 设为 `default-src 'none'`，脚本只接受 nonce，图片只允许扩展资源和 `data:`（`src/views/html.ts`）。
- `fetch`、pull 与 push 通过 `execFile('git', args)` 调用本机 Git；`GIT_TERMINAL_PROMPT=0` 禁止由扩展进程交互式索取凭据（`src/git/gitService.ts`）。这类用户触发的 Git 操作仍会访问用户配置的 remote，并可能执行该 Git 环境原本配置的 credential helper、hooks、filters 与网络策略；这些行为不应归类为扩展自身的遥测。
- 本次源码搜索未发现扩展直接读取、保存或传输密码、token、API key 或环境变量中的特定凭据。Git 进程会继承环境变量，因此 Git 自身及其 hooks 仍在宿主环境的信任边界内。
- 可见 Git 提交的作者邮箱、作者名、提交消息、文件路径、diff/patch 与 Shelf 内容在本机扩展 Host 和本地 webview 之间传递并显示。提交消息中的 `http(s)` URL 仅在用户点击后作为新链接打开；作者邮箱提供 `mailto:` 链接（`webview/src/shared/components/CommitInfo.tsx`）。这不是自动外发，但用户不应把提交消息中的链接当作可信链接。

### 本地持久化与剪贴板

- 普通 Shelf 使用 Git stash；IDEA Shelf 将 patch 和 XML 写入工作区 `.idea/shelf`。从文件或剪贴板导入的 patch 也会写入该目录。此内容可能包含源码和提交内容，属于工作区内的敏感本地数据。
- “Copy shelf patch” 及通用复制命令会把所选 patch 或文本写入系统剪贴板；“Import patch from clipboard” 会读取剪贴板文本。操作由用户界面触发，但应在 README 的隐私说明中明确。
- 导出 patch 使用 VS Code 保存对话框，由用户选择输出位置；不会自动写入外部服务。

## Webview 边界与输入处理

### 正向核查结果

- webview 的资源根限于扩展 `dist`，HTML 注入到 `data-*` 属性的额外值经过 HTML 转义。源码检索未发现 `eval`、`new Function`、`innerHTML`、`dangerouslySetInnerHTML` 或远程脚本资源。
- React 的普通文本渲染用于提交信息和路径。URL linkification 限制为 `http(s)`，并设置 `rel="noopener noreferrer"`。
- extension Host 使用 `execFile` 而非 shell 字符串拼接，因此本次没有发现典型 shell command injection 路径。

### P1：Host 未验证 webview 消息的结构与边界

`MessageRouter` 只检查 `msg.type` 和已注册的 command，随后将未经运行时验证的 `params` 传给高权限 handler（`src/messages/messageRouter.ts`）。多个 handler 将 `filePath`、`shelfName`、branch/ref 和 action 直接强制转换为 TypeScript 类型；类型断言不会在运行时校验不可信消息。

受影响的代表性路径：

- `saveMergedContent` 把 `params.filePath` 传给 `fs.writeFile(path.join(cwd, filePath))`；rollback 的新文件路径也用相同模式删除文件（`src/extension.ts`、`src/git/gitService.ts`）。
- `ideaUnshelveChanges` 与 `deleteIdeaShelf` 将 `shelfName` 直接拼入 `.idea/shelf` 下的读取、`git apply` 与递归删除路径。创建 Shelf 时的名称清洗不保护之后从消息输入读取的现有 shelf 名称。
- `checkout`、branch、remote、ref 和 stash 等参数在若干 Git 调用中缺少 `--` 终止选项或 Git ref 格式验证。例如 `checkout(branchName)` 调用 `git checkout branchName`。

本地隔离复现（不运行 VS Code、不接触真实工作区）：`scripts/security-smoke.cjs` 用 esbuild 编译并实例化本仓实际 `GitService`，在一次性临时 Git 仓库中调用 `saveMergedContent('../outside-write.txt', ...)`，成功改写 workspace 外的 sentinel；调用 `rollbackFile('../outside-delete.txt')`，成功删除 workspace 外的 sentinel。该脚本还在同一临时仓库通过本地 bare remote 成功运行实际 `fetch`、`pull` 和 `push`。这证明 Host 若收到被篡改的消息参数，路径约束会被绕过；**它不证明当前受 CSP 保护的正常 UI 已存在 XSS 或远程攻击入口。** 独立语义实验还确认 `execFile('git', ['checkout', '-f'])` 仍可使 Git 丢弃变更，说明无 shell injection 不等于参数没有危险语义。

建议在发布前修复：在 router/handler 边界实施 command-specific runtime schema；对工作区相对路径使用 canonical containment（解析后必须仍位于 workspace，处理符号链接）；对 Shelf 名称限制为已枚举且清洗后的条目；对 Git refs 使用 Git 的 ref-format 验证或受控枚举，并在适用位置添加 `--`。修复后应以恶意 `../`、选项前缀、符号链接和异常类型参数进行回归测试。

## 文件、Git 与 patch 操作

- 所有 Git 子进程从当前工作区 cwd 执行；`execFile` 避免 shell 解释，但不能限制 Git 本身执行用户配置的 hooks/filters，也不能使危险的 Git 操作变为可逆。
- reset、rebase、merge、checkout、rollback、drop commit、delete files 和 `git apply` 都会改变工作区或历史。部分入口带确认框，但 webview message handlers 不是完整的授权边界，见 P1。
- patch 仅做“看起来像 diff”的轻量检查。未发现自动上传 patch 的代码；未验证针对恶意 patch 的全部 Git 行为、二进制大小上限、符号链接与所有 Git 版本的处理差异。

## 历史与供应链范围

- 对所有可达 Git 历史（225 commits）执行了常见高置信度 secret 模式搜索，包括 AWS access key、GitHub token、Slack token、Google API key 与私钥 PEM 头；未命中。不可达对象计数为 0。此结果不构成对所有上游历史、低熵密码或已撤销秘密的完整审计。
- 根和 webview manifest 未声明 Git/URL/file 依赖；锁文件搜索未发现这类依赖来源。根和 webview package scripts 未声明 install/postinstall/prepare lifecycle scripts。
- 审计使用公开依赖名称和版本向 npm registry 查询，不上传源码、工作区文件、凭据或完整日志。根和 webview 的全依赖审计分别报告 66 和 38 项，但 production-only 审计均为 0 项；这降低了已安装生产依赖的已知漏洞信号，不能替代运行时可达性判断、锁文件更新和最终 VSIX 内容审查。

## 未覆盖与最终复核清单

- 未在隔离 VS Code 宿主中捕获启动、空闲、各面板与 Git remote 操作的系统级网络流量；因此仅能报告源码层未见主动联网，不能报告运行时网络观察通过。
- 未对真实 credential helper、hooks、filters、第三方 Git remote 或组织网络策略做测试；测试不得使用真实业务凭据或仓库。
- 最终 VSIX 的 26 项清单与 SHA-256 已复核：包含 nls/l10n 默认与简体/别名、构建产物、截图及原始 MIT 版权；不含 src、node_modules、测试 scripts、docs、旧 VSIX、`.idea`、`.kiro`、`.omc`。首次打包发现本地 `.idea` 文件会被收录，已通过 `.vscodeignore` 排除并重新打包。源码脚本和检查报告只保留在仓库中。
- 未完成 P1 修复和回归测试。因此不得在 README、发布页或其他对外文案中声称“无安全和隐私泄露问题”“已安全认证”或等价绝对结论。
- `scripts/security-smoke.cjs` 是审查工具，不得进入最终 VSIX；最终包清单需要确认它被 `.vscodeignore` 排除。

可在完成最终复核且 P1 修复后使用的保守事实说明为：JetGit 本次源码审查未发现遥测或扩展主动上传工作区数据；Git remote 操作由用户触发并通过本机 Git 执行；Shelf 和 patch 内容保留在本地工作区，复制/导入 patch 会使用系统剪贴板。该说明仍应链接本文件并标注审查版本与日期。

## 最终复核证据

- `pnpm run build`、`pnpm run vsce:package`、`pnpm run check:l10n` 通过；依赖版本和锁文件未修改，版本仍为 0.4.17。VSIX 已成功安装到临时隔离扩展目录，未安装到日常配置。
- `scripts/host-ui-check.cjs` 实际编译并调用当前 HTML/Host 代码，验证六种 mode 的语言注入、恶意属性转义、CSP，以及翻译后的回滚/删除确认仍调用相同操作。这里的 VS Code API 是测试 stub，不等于真实宿主安全认证。
- `scripts/security-smoke.cjs` 实际编译 GitService 并使用临时本地 bare remote，验证 fetch/pull/push，同时复现 P1 的越界写和删除；所有测试内容均为一次性 fixture。
- 真实 VS Code 1.137.0 arm64 的隔离宿主验证了英文、简体、繁体、德语清单与官方 l10n 加载。繁体使用简体，德语回退英文。真实 webview 的代表面板与提交右键菜单已检查；测试只操作临时冲突仓库。
- 最终包的繁体语言 webview 资源时序记录只列出 `style.css` 和 `main.js`，通过 VS Code 的 `file+.vscode-resource.vscode-cdn.net` 本地资源映射加载。此记录不等于系统级全流量捕获，不能排除未覆盖操作、Git 子进程或第三方插件的联网。
- 完整依赖审计摘要及公开 advisory/路径保存在 [security-dependencies.json](./security-dependencies.json)。其中根开发工具链 `npm-run-all > shell-quote@1.8.3` 有 critical advisory [GHSA-w7jw-789q-3m8p](https://github.com/advisories/GHSA-w7jw-789q-3m8p)；未在本任务中升级，开发工具风险仍需单独处理。
- 发现 5 个清单声明的 Commit 命令在原始基线中没有注册实现；已在运行测试中显式记录，不作为本次 i18n 新增回归，也未擅自补实现。

最终包本身不包含本报告，以避免把包的 SHA-256 写入包内造成自引用。README 的报告相对链接由 vsce 按项目 repository 转为源码文档链接；公开仓库中实际可见的检查记录取决于后续正常提交，本任务未提交或发布。

本阶段历史源码与资源集合摘要为 `df1193407a7637af176f6328d33743a53c6bac9b3557835db0799c1094252dd9`（116 个文件，集合与算法见 [validation-evidence.json](./validation-evidence.json)）。该摘要不包含报告自身、测试脚本及生成的语言别名，避免自引用。当前交付身份以文首 2026-09-15 的 VSIX SHA-256 为准。
