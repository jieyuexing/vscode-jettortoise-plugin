# JetTortoise 安全与隐私核查

日期：2026-09-16。基线 commit `32f7f5e4659f948cfbe2bf19412bfec0147c7f07`；当前是其上未提交的仓库目录与 diff 工作台工作树。上阶段版本完整保存在 [嵌套安全报告历史](./security-review-before-catalog.md)；更早合并记录见 [合并报告](./security-review-before-nesting.md)。更早记录保存在 [JetGit 历史安全报告](./security-review-jetgit-history.md)，其中旧 P1 与旧包摘要仅属于当时版本。

**已复现的 Git P1 在本次源码与隔离回归范围内修复通过；整体安全发布验收仍不能判为通过。** 开发工具链保留已知漏洞，且真实宿主流量、跨平台和部分外部客户端配置未覆盖。没有证据支持“零风险”“无安全或隐私泄露问题”等绝对声明。

## 绑定版本

| 项目 | 证据 |
| --- | --- |
| 产品身份 | `jetgit.jettortoise` / `0.4.17` |
| VSIX | `release/jettortoise-0.4.17.vsix`，3,528,541 bytes、26 项 |
| VSIX SHA-256 | `68e9a281a2d9c3122b55717f4eecf2ae9990f89140452471061f2e12986ca53b` |
| 源码集合 | 235 项，`8f58a5de380d5e8440db403952071a672af5e9df5c53a70d5a561267b8d5b1a0` |
| 差异范围 | 已有嵌套工作树上的 v2 仓库目录与保存恢复、元数据递归发现、定向更新、严格管理/比较通道、共享工作台及只读 diff、Git 路径解析、CVS 内容/诊断分流、回归与文档。依赖版本、锁文件与 Git 历史保持；原 JetCVS 起点 67 项文件的旧报告保留，但源目录当前不在原位置，本轮无法重新验证；没有写入或删除该源目录。 |
| 完整清单 | [jettortoise-evidence.json](./jettortoise-evidence.json)、[本轮起点清单](./evidence/before-catalog-baseline.json)、[迁移记录](./migration.md) |

## P1 复现、修复与回归

前一合并阶段改动前执行原 `security-smoke.cjs`：`saveMergedContent('../outside-write.txt', ...)` 可以改写外部 sentinel，`rollbackFile('../outside-delete.txt')` 可以删除外部 sentinel。这是已确认的失败基线，不是对正常 UI 可远程利用性的证明。

前一合并阶段增加了悬空符号链接的先失败、后修复检查：指向仓库外不存在目标的链接原本仍能写入，见 [修复前输出](./evidence/dangling-symlink-before.log)。现在连同悬空父目录和指向 `.git` 的别名均拒绝；合法仓库内链接的回滚仅删除链接，保留目标文件。此项与普通 symlink 逃逸一起进入当前回归集合。

| 边界 | 当前实现与检查 |
| --- | --- |
| 消息结构及能力 | Git command-specific schema 拒绝未知命令、额外字段、类型/枚举错误、客户端 cwd/repository 注入；每个页面显式绑定 panel/merge/conflicts/push/rollback surface。CVS workspace 使用独立严格 schema，未实现 checkout 的 webview 请求也不放行，检出仅为 Host 命令。 |
| 仓库隔离 | 上下文固定为类型和 canonical root，标签、服务、队列、缓存、watcher、事件和 diff authority 独立。每次执行重新验证信任、工作区归属和仓库有效性；只从可信本地工作区启动客户端。 |
| 确认与排队 | 破坏性确认位于待执行的 Host action 内；排队时及确认之后检查页面仍存活、仓库仍有效。不能先请求一个通用确认，再直接发送执行消息绕过。关闭或取消不执行待确认操作；已进入内核的操作仍归原仓库。 |
| 工作区路径 | 在 Host 与可直接调用的 GitService 边界检查相对路径、canonical 目标/父目录和符号链接；拒绝绝对路径、穿越、仓库外目标和 `.git` 元数据目标。合法对话框选定的导入/导出路径仍允许在仓库外。 |
| Shelf | 只接受经枚举及校验的 Shelf 名称与标准 patch/XML 条目；拒绝目录、patch、XML 外部 symlink。XML PATH 不再决定读取/应用位置；恶意外部引用不会触碰 sentinel。仓库内 Shelf 根 symlink 保留支持。 |
| Git 参数 | refs、revision、remote、stash、枚举及数字参数按用途验证；文件参数在适用位置加 `--`。合法 Unicode、空格、前导连字符路径及 HEAD/remote refs/stash parent 通过。冲突 index stage 仅允许 `:0/:1/:2/:3`，真实三路 base/ours/theirs 内容通过。 |

当前检查包括 15 项 Git 负例及 index-stage、内部链接回滚检查、Router 队列与确认负例、14 项注册/URI 隔离检查。外部 sentinel 未变。实际 Host 使用两个临时 Git 仓和一个本地 CVS 工作副本，合法 Git 与 CVS 提交分别成功且没有改变其它仓的历史；伪造路径拒绝。详见 [验收记录](./jettortoise-validation.md)及 [catalog-headless.log](./evidence/catalog-headless.log)。

## 继续验证的嵌套边界

新增子仓保护独立于登记状态，Host 与直接内核入口均生效。与基线相比，`stageAll` 曾把嵌套 Git 条目加入父索引；保存事件曾同时刷新父仓。收尾对照还证明“子仓内指回父仓的链接”可被父仓删除，以及只检查 cached diff 会遗漏父索引中未改变的子仓条目。四份修复前输出见验收记录，修复后负例拒绝且哨兵/索引保持。

- `boundaries.cjs` 检查真实仓根及路径的实际、字面归属；CVS 连续工作副本关系结合 Root/Repository/Entries。全树预检有上限、跳过管理目录和 symlink、遇到独立子仓停止进入，无法证明边界完整时拒绝。
- Git 提交/修订检查完整索引，Host 在自动暂存所选文件之前也检查。全部暂存跳过已确认子仓；不擅自取消重叠暂存。Host 直接删除、合并保存、Shelf 存储读/导出/删除、目录操作与内核写路径均受保护。
- 递归 checkout/reset/merge/rebase、stash 恢复、整包 patch 和 CVS update 遇到子仓时保守拒绝；选中文件操作按其范围验证。父仓历史仍可读；普通父文件与子仓自身提交分别通过。
- 登记采用工作区状态，不能成为权限来源。最近子仓未登记时确认添加，取消不回退。物理根替换、移除登记、确认期间新建子仓及伪造边界 ID 均有拒绝回归。
- 当前窗口外的祖先仓根不再允许自动使用；这是 JetTortoise 的操作边界，不修改 VS Code 自带 Git 扩展的发现设置。恢复时取消登记可以保留页面，但没有执行权限。

新增 Git 嵌套 15 项、登记/窗口 22 项、保存路由 5 项检查，以及 2 项真实 CVS 综合测试已通过；Host 实际命令与模拟 VS Code API 的混合检查覆盖确认期间改变边界和提交前索引不变。它们没有验证真实窗口、全部子进程配置或恶意本地进程并发修改文件系统。

## 仓库目录、更新与预览检查

本轮生产 Host 的临时仓库回归先复现了未保存编辑器的路径别名漏判：编辑器 URI 使用 `/var`，仓根为 `/private/var`，原字符串前缀比较未阻止 pull。修复前的严格断言失败见 [日志](./evidence/catalog-dirty-editor-before.log)。现在 Git 更新、CVS 写入前检查以及两种预览的未保存提示共享真实路径解析；文件已从磁盘删除时从最近存在的父目录恢复真实路径。相同 Host 请求必须拒绝且目标文件保持原内容，清除未保存编辑后方可更新。仍不把检查与后续 CLI 执行当成无竞态事务。

- 新递归扫描只读取当前受信任本地工作区的元数据；不向窗口外祖先扩展，不跟随目录 symlink，不进入 Git/CVS 管理树，不因发现创建全部服务或执行网络命令。目录遍历并发有限，可取消；失败保留已保存记录并标记不完整。登记不赋予操作权限，隐藏不解除真实子仓保护。
- 独立管理消息只接受固定操作及 64 位 Host 仓库 ID，拒绝 cwd、多余字段和未知操作；仓库服务仍由 Host 映射。比较消息同样严格验证来源、路径、revision 和范围，运行前检查当前页面绑定。历史文件必须存在于 Host 解析的变更集合中。
- 右键 Git 更新进入目标仓的既有写队列，重新核对身份、信任、未保存文档、dirty/index、upstream、detached HEAD、进行中操作及子仓边界。固定 `pull --ff-only --no-rebase --no-autostash --no-recurse-submodules` 不接受客户端命令参数。取消/超时有回归，但中断不等于事务回滚；已有部分文件写入应通过刷新确认。CVS 同样复用原串行边界，失败不再被吞为成功。
- 原生与内嵌比较共用版本解析，暂存读取 index 而非磁盘。Git NUL 路径解析避免引用转义、箭头文本与组合状态导致比较目标错误。CVS 文件正文只用 stdout，不用诊断分隔文本猜测并截断真实正文。
- 预览为只读，每侧最多 2 MiB / 20,000 行，磁盘读取实际最多分配 2 MiB + 1，CLI 输出也有上限。二进制、非法 UTF-8、超限或复杂比较退回原因提示与原生入口。当前磁盘读取仍检查实际归属；父仓历史对象可读取。未保存编辑器只作提示，不冒充磁盘快照。
- 普通文本和 Shiki token 通过 React 文本节点渲染，恶意文本不会作为 HTML 执行；Host 数据转义/CSP 保持。比较请求序号与页面存活检查防止迟到响应覆盖其它文件，页面持久化不包含正文。源码中未引入下载脚本、远程高亮资源或新的网络依赖。

当前集合覆盖：管理消息 16 项、发现 14 项、保存恢复 10 项、定向 Git 更新 14 项、真实 Git/CVS 比较 57 项、前端 17 文件/70 项，加原嵌套与 P1 回归。模拟 Host 与 DOM 检查不是实际 VS Code UI、关闭重开或运行时网络观测。具体日志与限制见 [验收记录](./jettortoise-validation.md)。

## 数据流与隐私

- 当前源码未发现专用 HTTP/WebSocket、遥测/分析 SDK、自动更新器或主动上传工作区的代码。远程链接来自项目文档、致谢，以及用户点击的提交链接/邮箱。没有执行系统级流量捕获，故不把源码检查等同于“运行时无联网”。
- Git 操作使用本机 Git 的参数数组，CVS 使用本机 `cvs -f` 的参数数组，不进行 shell 拼接。Git fetch/pull/push 与 CVS checkout/status/history/update/commit 等远程工作副本操作可能访问用户配置的服务端；测试仅使用临时本地 remote / `:local:` 仓。
- Git 仍会继承进程环境并执行已有 hooks、filters、credential helper 等配置；这些属于受信任工作区和本机 Git 的边界。原始 Git 诊断可能包含路径、remote 地址或服务器返回文本，应按仓库数据对待，不写成完全无敏感数据。
- CVS 保留输出上限、取消、超时、错误脱敏、路径和 root 校验，只支持本地或不内嵌密码的 pserver root；认证交由本机客户端已有配置。未自动读取、导出或上传认证存储；未测试真实凭据或服务器登录。
- 文件、提交消息、作者、邮箱、路径、diff、Shelf/patch 在本机 Host 与受 CSP 限制的 webview 间处理。复制、patch 导入/导出是用户显式操作；剪贴板可被本机其它应用访问。
- Git stash、`.idea/shelf` patch/XML 和 CVS rollback 同目录备份会持久保留。新扩展在当前 VS Code 工作区内保存仓库登记、来源、隐藏标记、分支/标签及身份摘要，各页保存布局、历史与 diff 选择引用，比较正文不写入页面持久状态；Git 草稿仅在当前页面内存，CVS 草稿保存在 webview state。不存在旧扩展私有存储自动迁入。
- Webview 资源仅取本地 dist，CSP `default-src 'none'`，script 用 nonce；Host repository/语言/文件等 HTML 属性经过转义，普通文本由 React 渲染。恶意属性及语言输入的 headless 检查通过。VSIX README 的项目链接/图片 URL 不属于 webview 自动脚本请求。

## 依赖与源码残留

沿用 2026-09-15 合并验收中对公开 npm registry 的查询；本轮于 2026-09-16 重新核对两份锁文件未变，未重复查询。以下是该日期的已知结果，不是本日漏洞库的重新扫描。只发送公开依赖标识和版本，没有上传源码、凭据或完整日志。

| 范围 | low | moderate | high | critical |
| --- | ---: | ---: | ---: | ---: |
| 根全依赖 | 4 | 22 | 39 | 1 |
| webview 全依赖 | 4 | 15 | 19 | 0 |
| 根 production-only | 0 | 0 | 0 | 0 |
| webview production-only | 0 | 0 | 0 | 0 |

两份全依赖结果不能相加成独立漏洞数。根工具链 `npm-run-all > shell-quote` 仍包含 [GHSA-w7jw-789q-3m8p](https://github.com/advisories/GHSA-w7jw-789q-3m8p)；本轮按约束未升级。生产依赖零命中不替代实际可达性审查，也不代表打包产物免疫所有未知漏洞。原始公开公告与依赖路径保存在 `docs/evidence/dependencies-*.json`。

对当前受跟踪/未忽略文件和 225 个本地可达 commits 检查常见高置信度 GitHub token、AWS access ID、私钥头，未命中；位置与扫描范围见 [catalog-secret-scan.json](./evidence/catalog-secret-scan.json)。检查不输出潜在秘密原值，不声称覆盖全部上游历史、不可达对象、低熵密码或全部秘密格式。

本轮最终 VSIX 的 26 项清单已重新检查，包含 nls/l10n 与简体别名、运行时资源及原始 MIT；无源码、脚本、node_modules、vendor、开发材料、source map 或旧 VSIX。CVS CLI 为用户本机安装的外部程序，没有把 CLI 二进制或 IntelliJ 集成/协议库打入包。

## 限制与后续验收

1. 旧 `vscode-jetcvs-plugin` 源目录当前不在历史路径；没有据历史摘要断言当前源文件仍在。当前插件已使用本仓迁入的 CVS 源码，构建与回归不依赖旧目录。
2. Node 普通文件 API 的路径校验和后续写入/删除/apply 之间仍有 TOCTOU 竞态；测试覆盖固定 symlink 逃逸，不证明恶意本地进程并发切换路径时的无竞态保证。
3. 没有启动真实 VS Code 测试窗口；真实标签移动/Reload/并排、安装切换、语言可视验收与系统级网络捕获未执行。
4. Windows/Linux、远程宿主、真实 CVS pserver/认证、用户 hooks/filters/credential helper 和所有 Git 版本、恶意 patch 组合未穷尽。
5. 依赖风险需另行按兼容性评估和升级验证；发布前还需实际宿主检查。不能据本次 P1 回归关闭而宣称整体安全发布验收通过。

GitHub 改名已由用户完成并核实原仓库 ID，本地 origin 已更新为新 SSH 地址。本轮在此基础上完成仓库列表、发现与 diff 工作台并重新生成 VSIX；前一包的报告单独保留，本报告绑定上表的新摘要。没有 commit、push、发布或安装行为。
