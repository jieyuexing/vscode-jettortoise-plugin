# JetTortoise 安全与隐私核查

日期：2026-09-15。基线 commit `32f7f5e4659f948cfbe2bf19412bfec0147c7f07`；当前是其上未提交的合并工作树。旧记录完整保存在 [JetGit 历史安全报告](./security-review-jetgit-history.md)，其中旧 P1 与旧包摘要仅属于当时版本。

**已复现的 Git P1 在本次源码与隔离回归范围内修复通过；整体安全发布验收仍不能判为通过。** 开发工具链保留已知漏洞，且真实宿主流量、跨平台和部分外部客户端配置未覆盖。没有证据支持“零风险”“无安全或隐私泄露问题”等绝对声明。

## 绑定版本

| 项目 | 证据 |
| --- | --- |
| 产品身份 | `jetgit.jettortoise` / `0.4.17` |
| VSIX | `release/jettortoise-0.4.17.vsix`，3,502,346 bytes、26 项 |
| VSIX SHA-256 | `88982d9cf3576fbf2fbcecba5900d417f982872762e04a167df7103140920d22` |
| 源码集合 | 210 项，`42daffa515e77a1cfa0727cd5e6b29ca7f7f579029f615a8705c2b4fcb16011b` |
| 差异范围 | 原 JetGit 工作树上的品牌/身份、仓库注册分派、CVS 迁入、四栏适配、安全边界、测试和文档。依赖版本、锁文件与 Git 历史保持；原 JetCVS 起点 67 项文件逐一未变。 |
| 完整清单 | [jettortoise-evidence.json](./jettortoise-evidence.json)、[起点清单](./evidence/vscode-jetgit-plugin-baseline.json)、[迁移记录](./migration.md) |

## P1 复现、修复与回归

本轮改动前再次执行原 `security-smoke.cjs`：`saveMergedContent('../outside-write.txt', ...)` 可以改写外部 sentinel，`rollbackFile('../outside-delete.txt')` 可以删除外部 sentinel。这是已确认的失败基线，不是对正常 UI 可远程利用性的证明。

收尾增加了悬空符号链接的先失败、后修复检查：指向仓库外不存在目标的链接原本仍能写入，见 [修复前输出](./evidence/dangling-symlink-before.log)。现在连同悬空父目录和指向 `.git` 的别名均拒绝；合法仓库内链接的回滚仅删除链接，保留目标文件。此项与普通 symlink 逃逸一起进入当前回归集合。

| 边界 | 当前实现与检查 |
| --- | --- |
| 消息结构及能力 | Git command-specific schema 拒绝未知命令、额外字段、类型/枚举错误、客户端 cwd/repository 注入；每个页面显式绑定 panel/merge/conflicts/push/rollback surface。CVS workspace 使用独立严格 schema，未实现 checkout 的 webview 请求也不放行，检出仅为 Host 命令。 |
| 仓库隔离 | 上下文固定为类型和 canonical root，标签、服务、队列、缓存、watcher、事件和 diff authority 独立。每次执行重新验证信任、工作区归属和仓库有效性；只从可信本地工作区启动客户端。 |
| 确认与排队 | 破坏性确认位于待执行的 Host action 内；排队时及确认之后检查页面仍存活、仓库仍有效。不能先请求一个通用确认，再直接发送执行消息绕过。关闭或取消不执行待确认操作；已进入内核的操作仍归原仓库。 |
| 工作区路径 | 在 Host 与可直接调用的 GitService 边界检查相对路径、canonical 目标/父目录和符号链接；拒绝绝对路径、穿越、仓库外目标和 `.git` 元数据目标。合法对话框选定的导入/导出路径仍允许在仓库外。 |
| Shelf | 只接受经枚举及校验的 Shelf 名称与标准 patch/XML 条目；拒绝目录、patch、XML 外部 symlink。XML PATH 不再决定读取/应用位置；恶意外部引用不会触碰 sentinel。仓库内 Shelf 根 symlink 保留支持。 |
| Git 参数 | refs、revision、remote、stash、枚举及数字参数按用途验证；文件参数在适用位置加 `--`。合法 Unicode、空格、前导连字符路径及 HEAD/remote refs/stash parent 通过。冲突 index stage 仅允许 `:0/:1/:2/:3`，真实三路 base/ours/theirs 内容通过。 |

当前检查包括 15 项 Git 负例及 index-stage、内部链接回滚检查、Router 队列与确认负例、12 项注册/URI 隔离检查。外部 sentinel 未变。实际 Host 使用两个临时 Git 仓和一个本地 CVS 工作副本，合法 Git 与 CVS 提交分别成功且没有改变其它仓的历史；伪造路径拒绝。详见 [验收记录](./jettortoise-validation.md)及 [headless.log](./evidence/headless.log)。

## 数据流与隐私

- 当前源码未发现专用 HTTP/WebSocket、遥测/分析 SDK、自动更新器或主动上传工作区的代码。远程链接来自项目文档、致谢，以及用户点击的提交链接/邮箱。没有执行系统级流量捕获，故不把源码检查等同于“运行时无联网”。
- Git 操作使用本机 Git 的参数数组，CVS 使用本机 `cvs -f` 的参数数组，不进行 shell 拼接。Git fetch/pull/push 与 CVS checkout/status/history/update/commit 等远程工作副本操作可能访问用户配置的服务端；测试仅使用临时本地 remote / `:local:` 仓。
- Git 仍会继承进程环境并执行已有 hooks、filters、credential helper 等配置；这些属于受信任工作区和本机 Git 的边界。原始 Git 诊断可能包含路径、remote 地址或服务器返回文本，应按仓库数据对待，不写成完全无敏感数据。
- CVS 保留输出上限、取消、超时、错误脱敏、路径和 root 校验，只支持本地或不内嵌密码的 pserver root；认证交由本机客户端已有配置。未自动读取、导出或上传认证存储；未测试真实凭据或服务器登录。
- 文件、提交消息、作者、邮箱、路径、diff、Shelf/patch 在本机 Host 与受 CSP 限制的 webview 间处理。复制、patch 导入/导出是用户显式操作；剪贴板可被本机其它应用访问。
- Git stash、`.idea/shelf` patch/XML 和 CVS rollback 同目录备份会持久保留。新扩展在 VS Code 内保存仓库根、各页布局和历史选择；Git 草稿仅在当前页面内存，CVS 草稿保存在 webview state。不存在旧扩展私有存储自动迁入。
- Webview 资源仅取本地 dist，CSP `default-src 'none'`，script 用 nonce；Host repository/语言/文件等 HTML 属性经过转义，普通文本由 React 渲染。恶意属性及语言输入的 headless 检查通过。VSIX README 的项目链接/图片 URL 不属于 webview 自动脚本请求。

## 依赖与源码残留

2026-09-15 重新向公开 npm registry 查询当前锁文件。只发送公开依赖标识和版本，没有上传源码、凭据或完整日志。

| 范围 | low | moderate | high | critical |
| --- | ---: | ---: | ---: | ---: |
| 根全依赖 | 4 | 22 | 39 | 1 |
| webview 全依赖 | 4 | 15 | 19 | 0 |
| 根 production-only | 0 | 0 | 0 | 0 |
| webview production-only | 0 | 0 | 0 | 0 |

两份全依赖结果不能相加成独立漏洞数。根工具链 `npm-run-all > shell-quote` 仍包含 [GHSA-w7jw-789q-3m8p](https://github.com/advisories/GHSA-w7jw-789q-3m8p)；本轮按约束未升级。生产依赖零命中不替代实际可达性审查，也不代表打包产物免疫所有未知漏洞。原始公开公告与依赖路径保存在 `docs/evidence/dependencies-*.json`。

对当前受跟踪/未忽略文件和 225 个本地可达 commits 检查常见高置信度 GitHub token、AWS access ID、私钥头，未命中；位置与扫描范围见 [secret-scan.json](./evidence/secret-scan.json)。检查不输出潜在秘密原值，不声称覆盖全部上游历史、不可达对象、低熵密码或全部秘密格式。

最终 VSIX 的 26 项清单已检查，包含 nls/l10n 与简体别名、运行时资源及原始 MIT；无源码、脚本、node_modules、vendor、开发材料、source map 或旧 VSIX。CVS CLI 为用户本机安装的外部程序，没有把 CLI 二进制或 IntelliJ 集成/协议库打入包。

## 限制与后续验收

1. Node 普通文件 API 的路径校验和后续写入/删除/apply 之间仍有 TOCTOU 竞态；测试覆盖固定 symlink 逃逸，不证明恶意本地进程并发切换路径时的无竞态保证。
2. 没有启动真实 VS Code 测试窗口；真实标签移动/Reload/并排、安装切换、语言可视验收与系统级网络捕获未执行。
3. Windows/Linux、远程宿主、真实 CVS pserver/认证、用户 hooks/filters/credential helper 和所有 Git 版本、恶意 patch 组合未穷尽。
4. 依赖风险需另行按兼容性评估和升级验证；发布前还需实际宿主检查。不能据本次 P1 回归关闭而宣称整体安全发布验收通过。

GitHub 改名已由用户完成并核实原仓库 ID，本地 origin 已更新为新 SSH 地址。本次只更新迁移状态，没有修改已核查的运行源码或 VSIX；原安全结论与限制保持。没有 commit、push、发布或安装行为。
