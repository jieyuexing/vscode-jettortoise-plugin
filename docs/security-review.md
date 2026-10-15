# 安全与隐私边界

本文说明 JetTortoise 在输入、路径、确认、数据流方面的边界，以及这些边界的回归检查范围。它不是“无漏洞”保证：开发工具链保留已知依赖告警，真实宿主流量、跨平台和部分外部客户端配置未覆盖。

## 输入与边界

| 边界 | 实现与检查 |
| --- | --- |
| 消息结构及能力 | Git command-specific schema 拒绝未知命令、额外字段、类型/枚举错误、客户端 cwd/repository 注入；每个页面显式绑定 panel/merge/conflicts/push/rollback surface。CVS workspace 使用独立严格 schema，未实现 checkout 的 webview 请求也不放行，检出仅为 Host 命令。 |
| 仓库隔离 | 上下文固定为类型和 canonical root，标签、服务、队列、缓存、watcher、事件和 diff authority 独立。每次执行重新验证信任、工作区归属和仓库有效性；只从可信本地工作区启动客户端。 |
| 确认与排队 | 破坏性确认位于待执行的 Host action 内；排队时及确认之后检查页面仍存活、仓库仍有效。不能先请求一个通用确认，再直接发送执行消息绕过。关闭或取消不执行待确认操作；已进入内核的操作仍归原仓库。 |
| 工作区路径 | 在 Host 与可直接调用的 GitService 边界检查相对路径、canonical 目标/父目录和符号链接；拒绝绝对路径、穿越、仓库外目标、`.git` 元数据目标，以及指向仓库外不存在目标的悬空链接。合法对话框选定的导入/导出路径仍允许在仓库外。 |
| Shelf | 只接受经枚举及校验的 Shelf 名称与标准 patch/XML 条目；拒绝目录、patch、XML 外部 symlink。XML PATH 不决定读取/应用位置。仓库内 Shelf 根 symlink 保留支持。 |
| Git 参数 | refs、revision、remote、stash、枚举及数字参数按用途验证；文件参数在适用位置加 `--`。合法 Unicode、空格、前导连字符路径及 HEAD/remote refs/stash parent 通过。冲突 index stage 仅允许 `:0/:1/:2/:3`。 |
| 未保存编辑器 | Git 更新、CVS 写入前检查以及预览的未保存提示共享真实路径解析（含 `/var` 与 `/private/var` 这类别名）；文件已从磁盘删除时从最近存在的父目录恢复真实路径。 |

## 嵌套边界

子仓保护独立于登记状态，Host 与直接内核入口均生效：

- `boundaries.cjs` 检查真实仓根及路径的实际、字面归属；CVS 连续工作副本关系结合 Root/Repository/Entries。全树预检有上限、跳过管理目录和 symlink、遇到独立子仓停止进入，无法证明边界完整时拒绝。
- Git 提交/修订检查完整索引，Host 在自动暂存所选文件之前也检查。全部暂存跳过已确认子仓；不擅自取消重叠暂存。Host 直接删除、合并保存、Shelf 存储读/导出/删除、目录操作与内核写路径均受保护。
- 递归 checkout/reset/merge/rebase、stash 恢复、整包 patch 和 CVS update 遇到子仓时保守拒绝；选中文件操作按其范围验证。父仓历史仍可读。
- 登记采用工作区状态，不能成为权限来源。最近子仓未登记时确认添加，取消不回退。物理根替换、移除登记、确认期间新建子仓及伪造边界 ID 均有拒绝回归。
- 当前窗口外的祖先仓根不允许自动使用；这是 JetTortoise 的操作边界，不修改 VS Code 自带 Git 扩展的发现设置。

## 仓库目录、更新与预览

- 递归扫描只读取当前受信任本地工作区的元数据；不向窗口外祖先扩展，不跟随目录 symlink，不进入 Git/CVS 管理树，不因发现创建全部服务或执行网络命令。目录遍历并发有限，可取消；失败保留已保存记录并标记不完整。登记不赋予操作权限，隐藏不解除真实子仓保护。
- 管理消息只接受固定操作及 64 位 Host 仓库 ID，拒绝 cwd、多余字段和未知操作。比较消息同样严格验证来源、路径、revision 和范围，运行前检查当前页面绑定。历史文件必须存在于 Host 解析的变更集合中。
- 右键 Git 更新进入目标仓的既有写队列，重新核对身份、信任、未保存文档、dirty/index、upstream、detached HEAD、进行中操作及子仓边界。固定 `pull --ff-only --no-rebase --no-autostash --no-recurse-submodules`，不接受客户端命令参数。中断不等于事务回滚；已有部分文件写入应通过刷新确认。
- 原生与内嵌比较共用版本解析，暂存读取 index 而非磁盘。Git NUL 路径解析避免引用转义、箭头文本与组合状态导致比较目标错误。CVS 文件正文只用 stdout。
- 预览为只读，每侧最多 2 MiB / 20,000 行，CLI 输出也有上限。二进制、非法 UTF-8、超限或复杂比较退回原因提示与原生入口。未保存编辑器只作提示，不冒充磁盘快照。
- 普通文本和 Shiki token 通过 React 文本节点渲染；Host 数据转义/CSP 保持。比较请求序号与页面存活检查防止迟到响应覆盖其它文件，页面持久化不包含正文。

## 数据流与隐私

- 源码中没有专用 HTTP/WebSocket、遥测/分析 SDK、自动更新器或主动上传工作区的代码。远程链接来自项目文档、致谢，以及用户点击的提交链接/邮箱。未执行系统级流量捕获，源码检查不等同于“运行时无联网”。
- Git 操作使用本机 Git 的参数数组，CVS 使用本机 `cvs -f` 的参数数组，不进行 shell 拼接。Git fetch/pull/push 与 CVS checkout/status/history/update/commit 等操作可能访问用户配置的服务端。
- Git 继承进程环境并执行已有 hooks、filters、credential helper 等配置；这些属于受信任工作区和本机 Git 的边界。原始 Git 诊断可能包含路径、remote 地址或服务器返回文本，应按仓库数据对待。
- CVS 保留输出上限、取消、超时、错误脱敏、路径和 root 校验，只支持本地或不内嵌密码的 pserver root；认证交由本机客户端已有配置。不读取、导出或上传认证存储。
- 文件、提交消息、作者、邮箱、路径、diff、Shelf/patch 在本机 Host 与受 CSP 限制的 webview 间处理。复制、patch 导入/导出是用户显式操作；剪贴板可被本机其它应用访问。
- Git stash、`.idea/shelf` patch/XML 和 CVS rollback 同目录备份会持久保留。扩展在当前 VS Code 工作区内保存仓库登记、来源、隐藏标记、分支/标签及身份摘要，各页保存布局、历史与 diff 选择引用，比较正文不写入持久状态；Git 草稿仅在页面内存，CVS 草稿保存在 webview state。
- Webview 资源仅取本地 dist，CSP `default-src 'none'`，script 用 nonce；Host 输出的 HTML 属性经过转义，普通文本由 React 渲染。

## 依赖

生产依赖只有 `node-diff3`（Host）以及 webview 的 React、Shiki、diff、allotment、zustand、react-virtual；`pnpm audit --prod` 在根与 `webview` 两处应为零命中。开发工具链保留的告警（例如 `npm-run-all > shell-quote`）不进入安装包。VSIX 只包含 `dist/`、nls/l10n、图标、README、CHANGELOG 与 LICENSE；不含源码、脚本、node_modules、source map。CVS CLI 是用户本机安装的外部程序，安装包不含 CLI 二进制或 IntelliJ 集成/协议库。

## 回归检查

`pnpm run test:headless` 运行 `scripts/` 下的无窗口检查：Git 负例与 index-stage、内部链接回滚、Router 队列与确认负例、注册/URI 隔离、嵌套 Git/CVS 边界、登记/窗口范围、保存路由、管理消息、发现、定向 Git 更新、真实 Git/CVS 比较，以及 webview 组件与 DOM 检查。检查使用临时 Git 仓、本地 bare remote 与临时 `:local:` CVS 仓，不向真实远程推送。

## 已知限制

1. Node 普通文件 API 的路径校验和后续写入/删除/apply 之间仍有 TOCTOU 竞态；测试覆盖固定 symlink 逃逸，不证明恶意本地进程并发切换路径时的无竞态保证。
2. 无窗口检查不是真实 VS Code UI：标签移动、Reload、并排、安装切换、语言可视验收与系统级网络捕获未自动执行。
3. Windows/Linux、远程宿主、真实 CVS pserver/认证、用户 hooks/filters/credential helper 和所有 Git 版本、恶意 patch 组合未穷尽。
