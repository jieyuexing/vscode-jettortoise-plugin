# JetTortoise 工程说明

本仓扩展身份为 `jieyuexing.jettortoise`，本轮从上游 `32f7f5e`（0.4.17）建立 `restart` 分支，版本 0.6.0。用户 2026-10-29 决定保留上游 Commit webview 和底部 Log 外壳，在本机构建多仓 Git/CVS 实验。`main` 不动、不推送、不发布、不启动 GUI，不触及 141 或台式机。README 只改名称与简介。

## 源码归属

- `src/extension.ts`：公共 Commit/Log 视图、原生命令和聚合只读修订 URI。
- `src/repositories/manager.ts`：按类型和真实根生成 ID、工作区内元数据发现、当前编辑器归属、独立快照和消息分发；视图只传已发现 ID，不传 cwd。
- `src/repositories/{boundaries.cjs,discovery.ts}`：从 main 移植的元数据发现、CVS 连续/同项目判定和物理子仓写边界。
- `src/repositories/{changes.ts,requests.ts}`：共享的纯分组模型和新入口运行时消息合同；分组模型不导入 Node、VS Code 或 VCS 内核。
- `src/git/{session.ts,gitService.ts,security.ts}`：每仓独立服务、消息合同、确认和写队列；保留上游图、分支、Shelf 与对话框。
- `src/cvs/{core.mjs,protocol.mjs,session.ts}`：现行 CVS CLI 内核、输入合同和每仓会话，保留取消、超时、脱敏、备份回滚。
- `src/scm/ignore.ts`：只复用忽略文件写入，不注册原生 SCM，也不改内置 Git 的配置。
- `webview/src/commit/`：上游提交区内按仓库再目录分组；`webview/src/panel/`：上游 Git 图与 CVS 文件历史。

## 交互与边界

更改（Changes）的计数只含已管理的本地变更。未受版本控制的文件（Unversioned Files）和传入（Incoming）默认折叠、不计数、不预选。未管理目录只展示节点，展开才读取其下一层；先通过“添加到版本控制”纳管，随后在更改中勾选提交。传入只读，不能提交，不显示复选框，以向下箭头标记远端新版本。更改的根文件直接列出，只有子目录创建目录组；分组内只显示文件名，关闭目录分组才显示路径。只有英文分组标题转大写，中文标题及目录保留原样；英文计数使用单复数 file/files，中文使用“N 个文件”，展开箭头复用上游 chevron。Git 的分阶段行合并为一个路径选择，提交取所选文件的磁盘内容；重命名带旧、新两条路径。

Git 与 CVS 每仓一次提交、各自排队，不把多个仓库承诺为一个原子事务。开始前验证全部所选根；逐仓失败会报告已经成功的仓库并保留说明。Git 先检查完整索引，再 `git commit -m <message> -- <paths>`，未选择的暂存内容保留。Amend 和 Commit and Push 只在单个 Git 仓选择中可用；Shelf/Stash 明示仅 Git。

一个 `kind + canonical root` 对应独立的服务、队列、watcher、快照、错误和修订内容访问权。当前编辑器只驱动底部 Log 的默认仓库；提交区明确选择的仓库优先控制 Update Project。Git 日志行在说明前显示分支/标签标记，说明保留完整文本并由行内布局在末尾省略，不修改原图或其它日志组件。CVS 文件历史只列所选文件的修订号、日期、作者和说明；点修订用原生 diff 比较上一修订。工作区 diff 为 Entries 的 BASE 与磁盘。

修订 scheme `jettortoise` 通过 `onFileSystem:jettortoise` 激活，恢复标签页的首次读取等待仓库发现；0.6.8 起，CVS 恢复修订页不自动连服务器，需显式重新打开差异才允许该会话读取相应修订。Git 的本地修订恢复不变。扩展另以 `onStartupFinished` 激活：Theia 1.76 只在视图展开时发 `onView`，布局恢复时已可见的 webview 视图不会触发，也不会像 VS Code 那样为 `contributes.views` 隐式补 `onView`，否则 ETECH Theia 里提交与日志视图空白。CVS 工作区 diff 使用动态 `BASE` URI，在每次队列读取时解析当前 Entries，标题不固定修订号；历史 diff 保持指定修订。提交、回滚和更新后，按仓触发已读取修订 URI 的文本与文件系统变更事件，并通知正显示该仓的 CVS 文件历史重新加载；其它仓不跟随刷新。嵌套边界拦截提示列出最多三个相对目录，余项显示 `and N more`。

CVS 登记、监听文件和焦点等自动路径只读 Entries/Entries.Log 本地段，不执行 CVS 命令；Git 自动路径只运行本地 status，不 fetch。用户显式刷新与已有写操作检查才在本地段之后运行 `cvs -f -n -q update`。焦点只读本地；保存只读该文件，保留最近确认的远端状态。网络结果为权威状态；网络开始前记录文件 mtime，只有其后 mtime 变化的文件才用本地结果覆盖。网络已确认干净的文件在 mtime 和修订号未变时继续保持干净，避免焦点刷新恢复假修改。网络失败保留本地快照并只在该仓显示错误。Git 沿用上游 watcher，每根独立；保存按真实物理归属判断。

**真实边界决定写权限，发现与展示不能解除边界。** 同项目但父 Entries 未登记的 CVS 目录不单列，也不进入父仓任何组，仍阻止父仓针对该目录的路径写入；CVS 已登记目录更新跳过它。连续 CVS 目录合并读取 Entries.Log。发现不越出工作区，不跟随目录软链；0.6.11 的目录忽略查询按下述大工作区合同，只运行固定的本地 Git 只读命令，不调用 CVS 或远端。最近真实边界即使未登记也保护文件，不回落祖先；子目录窗口不借用窗口外根。

文件修改重新检查归属和符号链接；Git 提交验证完整索引，包括已被父仓跟踪的子仓重叠。checkout/reset、merge/rebase、全量 stash、patch 沿用完整树预检，无法证明安全就拒绝。清单读取可在未管理目录停止，整树写预检不能使用这一优化。写操作在队列执行与确认后重新验证工作区可用性和信任；未保存编辑器阻止覆盖或提交。

Update Project 只更新当前分支 upstream，Git 固定 `pull --ff-only --no-rebase --no-autostash --no-recurse-submodules`，分叉不自动合并、变基或 stash。CVS 从根开始合并各层 Entries 与 Entries.Log 的 A/R 记录，仅收集本地存在且带 CVS 的已登记目录；只对该集合预检异 Root/Repository checkout 与 Git 边界。用 `cvs -q update -l -P . <相对目录…>` 逐层更新，不带 `-d`，服务器新目录不会创建；每批按包含可执行路径、`-f`、引号、空格及终止符的 Windows 转义上界计长，不超过 8000 字符，所有批次共用一次写队列与取消信号。通知区进度可取消。取消不承诺已经应用的文件写入自动回滚。

2026-10-30 用户确定用 `-l` 加显式已登记目录替代递归 update。依据两条本机 CVS 1.12.13 真实 `:local:` 实测：父 Entries 含 `D/src////`、无 Entries.Log 时，递归 `cvs -f -n update -P` 仍进入未登记的同项目 build，并输出 `M build/sentinel.txt`；`cvs -q update -l -P . ./src ./src/deep ./side` 不进入该 build，同时能取得已登记多层目录的服务器修改和新文件。真实回归也验证 Entries.Log 的 A 纳入、R 排除、服务器新目录不创建、已登记的异 Root/Git 边界拒绝，以及 8000 字符分批和批间取消。用户此前在 NsnWeb 实测 `update -d` 会拉下 WebContent、build、doc 并冲突，因此不能恢复 `-d`。更新后不另跑 `cvs -n -q update -d` 统计新目录：它需要额外遍历服务器目录，可能进入本轮明确跳过的 build 等大树，当前没有便宜且有界的计数入口。

不移植 catalog、四栏编辑器工作台、`packages/vcs-ui`、原生 SCM provider 或 `git.ignoredRepositories`。不读旧扩展存储，不注册旧命令前缀。依赖沿用 lockfile，不升级。

## 本地化与列表密度

2026-10-30 用户确定将界面本地化为简体中文，并按 IDEA 提交窗口压紧变更树。本轮只改显示文本与 Commit 变更树样式，不改分组、计数、折叠、勾选或写操作流程；不启动 GUI、不推送、不接入 141 或台式机。

- 清单文本由 `package.json` 中的 `%key%` 对应 `package.nls.json`（英文）和 `package.nls.zh-cn.json`（简体中文）。扩展端使用 `vscode.l10n.t`，`package.json` 的 `l10n` 指向 `./l10n`；英文原文为键，译文在 `l10n/bundle.l10n.zh-cn.json`，不另设英文 bundle。
- `src/views/html.ts` 将 `vscode.env.language` 经 HTML 转义写入根元素的 `data-language` 和页面 `lang`。`webview/src/shared/i18n/index.ts` 负责选择语言、替换参数和文件计数，`locales.ts` 保存英文字典及 `zh-cn` 字典；中文缺键回落英文，其它语言显示英文。不生成 `zh`、`zh-tw` 副本，不引入第三方 i18n 库。
- 译名参考 `main` 的清单、扩展 bundle、webview/CVS 和 `packages/vcs-ui` 字典；本轮明确要求优先于旧译名，统一 Commit→提交、Update Project→更新项目、Rollback→回滚、Changes→更改、Unversioned Files→未受版本控制的文件、Incoming→传入、Shelf→搁置、Commit and Push→提交并推送、Amend→修改提交。没有旧译名时沿用 IntelliJ IDEA 简体中文的操作叫法。Git/CVS 标识、分支名、修订号、文件路径和原始提交说明保持原值。
- 纯 Node 的 CVS 内核、路径和请求验证不导入 `vscode`。`src/cvs/session.ts` 在会话层将内核错误码转为译文；`src/messages/errors.ts` 在显示边界翻译固定错误与相对子仓提示，CLI 原始输出和开发者调试日志保持原值。
- `webview/src/commit/commit.css` 的仓库、分组、目录、文件行统一 20px／12px，每级缩进 16px。当前变更树的行内起点为 `8px + 层级 × 16px`，箭头槽 12px、图标 16px、控件间距 4px；浏览态无复选框，提交态按原交互加入复选框，所以文件名起点随层级与模式变化，不再用固定横坐标描述。仓库和目录计数紧随名称并使用次要色。2026-11-04 窄栏文字按分支→同步时间→文件数→名称依次让位，分类名称优先于计数。截断文字至少保留一个字与省略号，不足则整段隐藏；树行在已有 ResizeObserver 及可见行渲染后按实际字宽重新分配，宽度恢复时还原完整内容。真实窗口尺寸与截断由隔离开发构建另验。

`scripts/check-l10n.cjs` 已并入 headless：检查清单占位键、扩展端字面量翻译键、webview 全键及参数占位符，拒绝未翻译的 JSX/显示属性；用实际函数检查语言回落、中文计数、固定错误与 CLI 原文保留。

## ETECH Theia 左侧提交与底部日志（2026-10-30）

用户决定用 JetTortoise 代替 ETECH 的原生版本控制面板。产品集成与隔离 GUI 验证以总仓 `.local/tmp/etech-eclipse-layout/PROMPT-R3.md` 为本轮合同，覆盖本页旧实验的“不启动 GUI”限制；只使用本机复制的 Git/CVS 夹具，不触及公司机器。`onStartupFinished` 激活保持不变，不注册原生 SCM，不改内置 Git 配置或写操作合同。版本仍为 0.6.0，不推送、不发布。

- 底部容器和视图都使用清单已有的 Log／日志词条，去掉 JetTortoise 前缀；提交容器保持 Commit／提交。
- webview 主体清除宿主默认的左右 20px 留白。提交页签、工具栏和底部按钮固定单行，页签保留 Git 范围标识；工具按钮缩为 22px，窄栏超出时可横向滚动，不把按钮挤成多行。22px 变更树、16px 层级与选择、分组、计数规则保持原样。
- 界面颜色、状态图标、图线、滚动条和阴影使用 `--vscode-*` 主题变量，字体继承宿主的 font-family/font-size；不写死浅色或深色值。文件类型图标沿用上游图标库。日志焦点内使用 activeSelection，焦点离开使用 inactiveSelection 及对应前景色。
- 日志说明列占剩余空间；作者、日期、哈希分别最多占行宽 16%／24%／14%，宽屏仍使用原生拖动列宽。分支和标签最多占说明区 35%，说明至少保留 60%；过多图标与标记文字先截断，完整说明保留在 title。列标题和行使用相同上限。

验证仍走下列既有入口。源码、headless 与真实隔离窗口分别记录；本轮不据此承诺 Windows CVSNT、公司仓、Marketplace 或发布版本验收。

## 检查

使用 package.json 声明的 pnpm。测试临时目录由任务设置 `TMPDIR`、`TMP`、`TEMP`，本仓任务放总仓 `.local/tmp/<任务>/`。

```sh
pnpm run check-types
pnpm run lint
pnpm run build
pnpm run test:headless
pnpm run vsce:package
```

`test:headless` 合并分组、发现、Git/CVS 内核与子仓、消息合同、快进更新和公共 Host 集成检查，使用真实临时 Git 仓、本地 bare remote、`:local:` CVSROOT 与模拟 VS Code API。包装后路径为 `release/jettortoise-0.6.0.vsix`；打包已有 release 文件前先备份，打包后逐字节恢复并复核 SHA-256。

Headless、fixture 和构建通过不代表 VS Code 窗口交互、加载版本、安装、焦点、布局或 Windows CVSNT/公司环境验收。GUI 由协调者另行在隔离窗口验证，不从本任务自动安装、启用或发布。

## 工程资源命令（2026-10-30，0.6.1）

ETECH 工程右键通过公开命令 `jettortoise.updateProject`、`jettortoise.openCommitPanel`、`jettortoise.openHistory` 传入资源 URI；文件历史沿用 `jettortoise.showFileHistory`。新命令等待首次发现，再按资源的真实物理边界定位已发现仓库并核对工作区与信任；非法资源不回退到前一仓库。更新仍走原 request/update 队列、确认、可取消进度及 Git 快进／CVS 显式已登记目录规则。提交只选定所属仓并打开已有提交视图，不自动提交；工程历史清除旧文件选择，CVS 沿用已有文件选择器和修订列表，不宣称提供跨文件变更集日志。提交面板原有消息与行为保持不变。

检查沿用 `pnpm run test:headless`，`scripts/restart-host-check.cjs` 覆盖资源选仓、无效/失信拒绝和公开入口的真实本地 CVS 更新。版本只改 package.json 与 CHANGELOG.md，候选不推送、不打标签、不发布。


## 长列表密度（2026-10-30，0.6.2）

B2 按用户给出的 IDEA 参照统一 Git 日志与图线、CVS 文件历史、提交文件行、分支与标签树为 22px。GitGraphSvg 与 CommitList 使用 CommitRow 导出的同一行高，避免图节点和虚拟滚动错位。字体通过 `--font-size` → `--vscode-font-size` 继承宿主，CVS 修订号使用宿主等宽字体，无底色徽章；表头与行的内边距一致。保留分组、勾选、消息和 VCS 行为，检查仍从原有 headless 入口执行。候选由产品仓隔离解包试用，不推送、不打标签、不发布。

## 提交与日志可见性（2026-10-31，0.6.3）

Webview 显示／隐藏只由宿主布局负责；提交 provider 不再据可见性变化打开日志或关闭底栏。只有显式打开提交、历史等用户操作触发对应 focus 命令。回归并入 `scripts/restart-host-check.cjs`，由既有 `pnpm run test:headless` 运行。ETECH B3 集成任务在隔离开发构建验证底部本地更改／日志，不改变原生 VS Code 容器声明、仓库消息和写入合同。

## 本地更改三态（2026-10-31，0.6.4）

用户已确认 `/Users/jieyuexing/jieyuexing-universe/.local/tmp/etech-eclipse-ws/b5/mock/local-changes.html`（“对 就应该是这样”），它是本节唯一视觉基准，覆盖旧版常驻提交表单与尺寸说明。删除上一轮未采用的弹窗提交方案，不合并 `b5-codex-wip` 界面。任务书允许本机产品开发构建试装，覆盖旧实验“不启动 GUI”的限制；不推送、不改安装版。

- 浏览默认没有复选框与提交说明。30px 竖排工具栏、22px 行、14px 层级增量；按更改列表→仓库→目录分组，浅色逐项采用底稿变量，深色映射宿主主题。Git 的更改／搁置／储藏小页签仅在树列存在 Git 仓库时出现；窄于 760px 改为横排工具栏与树。
- 单击文件请求 `getWorkingFilePreview`；双击沿用 `showDiffForWorkingFile`。预览 Git 比较 HEAD 与磁盘，CVS 比较当前 Entries 的 BASE 与磁盘；只读并排／统一视图共用滚动、行号与行内着色。中缝回滚入口打开已有完整差异，不新增文件写入通道。
- 有界读取沿用 comparison resolver：每侧 2MiB、20000 行，前端最多合计 8000 行、diff 150ms/2000 次编辑，行内比较最多 4000 字符。超限、二进制或非 UTF-8 显示灰字，过时请求不覆盖新选择。忽略文件不参与现有变更扫描，树保留折叠入口并明确说明，不伪造忽略文件计数；传入分组保留只读。
- Ctrl+K 或工具栏进入提交态：预选全部可提交更改，复选框出现在同一棵树，说明框在树下获得焦点；Esc 或提交成功返回浏览，失败保留说明。提交并推送与修改上次提交仍仅允许单个 Git 仓库选择，不改原命令与写队列。无仓库只显示“此工作区没有 Git 或 CVS 仓库”。
- CVS 只读查询（预览、文件历史、文件清单）的进度位置为状态栏，写操作保持可取消通知；由 `scripts/restart-host-check.cjs` 断言。
- `webview/src/commit/commit-ui.test.tsx` 由既有 `pnpm run test:headless` 执行，原生 Git/CVS 预览与请求拒绝继续放 `scripts/restart-host-check.cjs`。结构、模拟交互与实际开发窗口分别记录，Windows 与真实公司仓未实机。

## 方案 C 组件化（2026-10-31，0.6.6）

当前尺寸合同以组件目录 `/Users/jieyuexing/jieyuexing-universe/.local/tmp/etech-eclipse-ws/b5/mock/components.html` 为准，覆盖上文历史 22px 行高和 B5 的 14px 缩进。界面字号 12px，仓库、分组、目录、文件、Git 日志与图线、CVS 修订表、分支与标签树均为 20px；每级缩进 16px。浏览态根文件从 8px 内边距、12px 空箭头槽、4px 间距起排，文件项内图标仍 16px；提交态另加现有复选框，不能用历史 x=48 推断当前浏览态位置。

- 十个尺寸变量只在 `webview/src/shared/theme/variables.css` 镜像，名称和值与产品 `/Users/jieyuexing/jieyuexing-universe/projects/etech/etech-theia-ide/theia-extensions/etech-eclipse-layout/src/browser/style/tokens.css` 一致，改值两处同步。颜色只读 Theia 导出的 `--vscode-*`，本地更改浅色固定调色板已删除；编辑器／差异正文的代码字号仍沿宿主。
- `webview/src/shared/components/VerticalToolbar.tsx` 与 `PanelHeader.tsx`、`panel-chrome.css` 供本地更改和日志共用。竖列 30px、按钮 22px、图标 16px、间距 1px、上下 4px，短面板滚动且隐藏工具列滚动条，禁用 40%。日志沿用分支工具列原动作；标题行 28px、12px，PanelHeader 的可选标题能力保留，本地更改与日志都不传标题，避免重复宿主页签名称；保留更改／搁置／储藏小页签与仓库选择行为。变更树容器不画焦点外框，选中行只在树内焦点时使用活动选中色，离焦消费 inactiveSelectionBackground／Foreground；按钮、输入、文本框自己的键盘焦点保留。日志列表沿用主题变量的活动／非活动选中，不新增列表级焦点框。
- Git 图与虚拟滚动共享 `CommitRow.ROW_HEIGHT`，从 CSS 镜像变量读取，未加载 CSS 时按同合同回落 20；不更改数据与 VCS 写入通道。headless 的本地化入口检查尺寸镜像与无硬编码颜色。
- 本轮允许在产品开发构建临时解包候选，不改安装版、不推送、不发布。VSIX 为 `release/jettortoise-0.6.6.vsix`；Windows、141、真实公司仓仍未验收。

## D1 左侧本地更改（2026-11-02，0.6.7）

用户确认的窄栏底稿为 `/Users/jieyuexing/jieyuexing-universe/.local/tmp/etech-eclipse-ws/b5/mock/workbench-c.html`，三态仍沿用同目录 `local-changes.html`；本轮开发构建可临时加载候选，交回前恢复原插件，不推送、不发布、不改安装版。

- 现有 ResizeObserver 的小于 760px 布局改为单行「本地更改」、浅色文件数，以及刷新／提交／回滚／更多四个动作；删除旧窄栏整排工具按钮及常驻的更改／搁置／储藏页签，相关动作移入更多。宽布局保持原样。
- 窄栏只有变更树，双击文件继续在编辑器打开差异。浏览态不显示复选框和说明；提交态在同一棵树显示勾选，说明框在树下。无仓库保持灰字空态。动作仍走现有 bridge、选仓、确认和写入队列，没有新增 VCS 写通道。
- 产品控制容器位置与互斥显示；默认左侧本地更改、底部日志。仓库选择行使用已有 28px PanelHeader；真实 CDP 测得控件上／下留白 3.5／4.5px，文字居中误差 0.25px，无需改该行。

`pnpm run check-types`、`pnpm run lint`、`pnpm run build`、`pnpm run test:headless`、`pnpm run vsce:package` 均退出 0；新增窄栏交互用例先红后绿，headless 中 UI 共 9 项通过。实际加载版本、临时替换与逐文件恢复、截图及仓库发现排查见 `/Users/jieyuexing/jieyuexing-universe/.local/tmp/etech-eclipse-ws/d1/RECORD.md`。用户原工作区“没有仓库”与 `main*` 不一致未在四组合成仓复现，未据推断修改发现逻辑；Windows、141 和公司 SCM 未覆盖。

D1b（同为 0.6.7，2026-11-02）：按组件目录「3 面板标题行」将窄栏自有标题改为 10px 左内边距、28px 行高、12px／600／1.4 字体，与 Theia 原生项目标题分别实现且几何相同；更多／收起常显，刷新／提交／回滚在面板悬停或键盘焦点时出现。首行箭头从 8px 起排，后续层级仍加 16px，宽布局在该阶段沿用 6px；2026-11-04 按 D1b 与同角色一致原则统一宽窄布局为 8px。收起请求只允许固定空字段，通过已登记的 Theia 左面板命令或 VS Code closeSidebar 完成，不进入选仓或 VCS 写队列。既有 headless 入口覆盖两种宿主命令及额外字段拒绝，UI 用例覆盖收起入口；产品侧真实 CDP 测得标题左边距 10px、居中误差 0.398px、首行缩进 8px。测试、VSIX、实际加载版本、临时替换恢复与浅深色截图见 `/Users/jieyuexing/jieyuexing-universe/.local/tmp/etech-eclipse-ws/d1b/RECORD.md`。


## 大工作区刷新与渲染（2026-11-03，0.6.8）

用户 ETW-E1 决定打开与自动刷新不连网，所有仓库网络命令全局并发最多 2。`src/repositories/network.cjs` 在 CVS 进程及 Git fetch/pull/push/ls-remote/clone 执行边界共用；本地 Git 命令不占位，队列内再次核验存活与取消，保留每仓写队列。忽略文件写后仅本地刷新；显式添加、回滚、更新、提交保持原有操作合同。未查询服务器前没有传入状态是预期行为。

变更树在原 20px 行与 16px 缩进上展平可见模型，仅挂载视口和前后各 6 行；方向键、Home/End 按完整模型定位并挂载目标，折叠后夹紧滚动位置。文件勾选、懒展开、右键和预览沿用原动作。0.6.11 起，初始连接先传文件为空的仓库摘要与加载标记，随后分批传文件（见下文），覆盖旧版“初始连接仍传完整快照”；后续小变更通知发送 changed/removed 与仓元数据；前端直接消费通知，不为每条通知重新拉取全工作区。登记与选仓通知不携带文件。

数量上限的当前行为以「扫描暂停」一节为准，覆盖本节原来的逐仓通知和只能重开工作区恢复规则；写入仍独立验证真实边界，不能以停扫解除保护。检查并入既有 `pnpm run test:headless` 的 `scripts/repository-performance-check.cjs` 与 UI 用例，只有合成仓和本地进程，不连接公司服务。ETW-E1 授权合成工作区开发构建 GUI 验收，覆盖本页历史实验的“不启动 GUI”限制。


E1 远端入口补查：CVS 历史挂载、自动选文件与编辑器跟随只读取本地文件清单，远端历史由现有文件选择、刷新历史或显式打开历史命令触发；写后历史刷新仍源于用户写操作。恢复的 CVS 修订 URI 不再直接取服务器；只有当前会话通过显式差异入口签发的 URI 才读取远端，保持队列内 BASE 解析、动态失效和独立边界预检。这是“打开不连网”优先于 0.6.0 自动恢复 CVS 内容的明确行为调整，没有新增控件。


E1 追加视觉决定（2026-11-03）：用户否定 6 万列表观感，以 `local-changes.html` 的交互和 `components.html`「2 树行」为准，不新增控件。树行统一基础内边距 8px（2026-11-04 按 D1b 与同角色一致原则更新，覆盖 E1 原 6px）、每级 16px、行高 20px／字号 12px，箭头槽 14px 内放 12px 箭头、间距 5px、右留白 8px；宽窄布局均使用 8px 树基础内边距。类别标题 600，仓库／目录／文件 400；仓库仍是逻辑分组，保留 CVS/Git 标签，不把单文件仓库合并。目录用既有灰色文件夹，文件图标 16px 读取当前安装主题：公开 `vscode.extensions` 贡献和 workbench.iconTheme，限主题目录内的图片，批量读取仅可视文件，浅深色由 webview 主题类选择；无图片主题时沿用已有图标回落。字体图标主题的字体渲染不在本次范围。仓库按自然名称排序并以类型、根路径确定同名顺序。文件选择的背景横跨整行，活动／离焦分别消费宿主 list.activeSelectionBackground／list.inactiveSelectionBackground，移除文件和树标签描边；提交表单与工具按钮保留焦点标识。文件名只占剩余宽度，过长省略，不挤走图标。


## CVS 按需同步（2026-11-03，0.6.9）

CVS 仓库按需同步，未同步不加载。工作区发现仅保留本地元数据与物理边界；未同步不读文件状态、不执行 CVS，Git 仍自动读取本地状态。资源管理器末组“与资源库同步”仅在含 CVS/Root 且上级无 CVS 的根目录出现，命令再次验证真实根、工作区与信任；打开本地更改和日志，先发布本地快照，再走既有全局并发 2 网络队列执行一次只读 update。未同步仓不参与刷新全部。

同步状态仅在内存；仓库行保留 20px／12px／16px 层级，在分支后显示本窗口最近同步时间。复用工具栏按钮，行尾 16×16 移除按钮悬停或键盘聚焦才显示。移除处置旧会话、取消排队工作并清除快照，重新扫描不会自动恢复。已同步仓文件事件继续仅刷新本地。底部提示高 24px、左距 10px、字号 12px、--dim 颜色、上边 1px --line，未同步计数归零隐藏；纯 CVS 未同步工作区同样显示提示。项目树装饰保持现状。

回归沿用 scripts/repository-performance-check.cjs、scripts/restart-host-check.cjs 与 commit-ui.test.tsx，并入现有 headless；合成夹具、红绿结果与真实窗口验收边界见本轮 RECORD，不将 headless 成功等同 GUI 验收。

2026-11-04 日志仓库及CVS文件历史刷新均复用shared/components/ToolbarButton与PanelHeader，按钮22×22、codicon refresh图标16px，中文tooltip/aria-label为“刷新”与“刷新文件历史”；同行下拉框垂直居中、按钮右距8px，回调与显式查询合同不变。既有Commit工具栏和树行入口改为从shared导入同一组件，不另建按钮样式体系。

## 扫描暂停（2026-11-04，0.6.10）

用户反馈「为什么上来就爆一堆错误」，要求不提高上限，并让超限状态留在仓库行。此决定覆盖 E1 的逐仓警告和会话内禁止手动扫描：真实 `SCAN_LIMIT`（10000 目录）或 `inventoryLimit`（20000 CVS 文件）保留已有文件、暂停自动重试，不弹通知；损坏边界和非法路径不再冒充数量上限，操作失败仍走既有错误通道。

- 本地更改的更改组保留干净暂停仓，同行依次为名称、Git/CVS 标签、分支、同步时间、文件数、dim 状态「仓库较大，已暂停自动扫描」，行尾动作依次为扫描、移除。窄栏按分支 → 同步时间 → 文件数 → 暂停状态 → 名称让位；辅助文字不足一字加省略号时整段隐藏，名称至少保留一字加省略号。标签和 `ToolbarButton` 的 22×22 扫描入口、16px refresh 图标不参与压缩；按钮 tooltip 与 aria-label 始终为完整暂停原因及继续扫描动作。树行仍为 20px，按钮居中。
- 固定请求 `scanRepository` 必须携带已登记 repositoryId，拒绝 cwd、root、network 等额外字段；重新核验工作区和信任后仅重试该仓的本地状态。若仍超限，保持暂停；规模减小后可恢复，无需重开窗口。它不是分页遍历，也不绕过原上限。未同步 CVS 不允许以扫描请求绕过 E2。
- 暂停也是完整快照的合法元数据：首次失败仍发首快照，后续 delta 比较暂停标记；仓库列表独立发布，不因超限清空。Git 自动状态使用 status -unormal 和变更路径祖先检查，不进入忽略目录或嵌套仓内部；递归写预检仍检查忽略树并在子仓根停止。发现独立仓库的遍历与状态扫描是不同入口，不把发现范围当作上限原因。
- 首个 Git 仓在登记时即设为日志默认仓，不等待整个发现遍历结束；不覆盖用户后续选仓。台式机真实窗口曾出现下拉已有数百个选项、日志正文仍显示没有可用仓库，原因是首仓选择延后，不是数量上限清空列表。这只解释该日志空态，不能据此宣布 M3 左侧整块空白已定位。
- CVS 发现保留本地管理元数据，0.6.9 起未同步不调用 localStatus/inventory；按需同步之后才盘点。本节回归并入现有性能、CVS 边界与 UI 检查；GUI 只在任务指定隔离产品开发构建临时加载候选，不改固定下载地址、不推送、不发布。
- CVS 历史文件清单与首次状态刷新共用本地队列，超限统一由会话发布暂停，不从另一次并发盘点抛红字错误。暂停期间历史挂载不盘点，恢复仅刷新本地清单，不自动查询远端修订；真实读取失败仍保留具体错误。


## 大工作区首屏与保存监听（2026-11-04，0.6.11）

用户 2c 要求：六万变更文件、两千嵌套仓规模下，点击版本控制后一秒内显示实际可见的本地更改、仓库行与计数（允许加载中），保存监听不随仓库数增加；A/B 修复后复测 Markdown，不另改 Markdown 插件。

- manager 只注册一个全局保存事件，按词法根筛选后由 Git watcher 重验物理边界。独立 watcher 默认仍自行监听；manager 创建的会话关闭其保存订阅。父 Git 精确跟踪子仓路径时仍参与保存刷新，不把未登记子仓交给父仓写入。
- 本地 Git 状态最多同时运行四仓，同仓在途普通刷新共用一个任务。CVS 继续沿用本地／网络队列和按需同步，不占此 Git 槽位；焦点不查询服务器。仓库列表通知合并至 50ms，发现进度至 100ms；第一批根仍及时登记。
- 提交视图 HTML 通过既有转义 data 属性内嵌同一份无文件摘要，store 首次加载即消费，避免先绘制空列表再等一次 RPC；完整文件仍走原消息通道。`getRepositories`／`getRepositoryChanges` 的 webview 响应先返回文件为空的摘要，计数显示“正在加载…”。文件每批最多 5000 条、批间让出 16ms，最后一批恢复真实 refreshing。连接、仓库或新快照会取消旧批次，每次请求使用独立传输标记；初始响应等待期间更新的仓库使用最新快照继续传输。内部 manager 请求仍提供完整状态，提交、选择与写队列合同保持原样。
- 提交树继续只挂载可视行。日志右侧的文件树原来递归挂载全部文件，六万变更会生成约 24 万 DOM，阻塞共用渲染进程中的 Markdown；现在同样仅挂载视口及前后六行，树形／平铺、折叠、单击、双击、右键与状态色沿用原回调。共享树构建用路径 Map 与复用 Collator；其它使用者保持原展示方式。不可变仓库快照复用文件分组，单仓更新不重建其它大仓文件。
- Git 自动发现用固定 `git -C <root> ls-files --others --ignored --exclude-standard --directory -z`，设置 `GIT_OPTIONAL_LOCKS=0`、禁止终端凭据交互，限定缓冲、超时并支持取消。此用户决定覆盖旧发现“完全不调用 VCS CLI”的限制；不执行任意 Git 参数、配置写入或网络命令。依据 Git 原生目录忽略结果，忽略目录中的嵌套 Git 不自动登记；显式工作区根仍登记。VS Code Git 也提供 `git.repositoryScanIgnoredFolders`（默认 node_modules）和 `git.repositoryScanMaxDepth`（默认 1）限制自动发现；本插件保留 E2 的递归 Git 发现范围，不擅自改成 VS Code 的深度设置。
- Git 忽略只影响 Git 登记，不剪掉目录遍历：被忽略树中独立 CVS 仍读取管理元数据、提供按需同步入口，不启动 CVS 清单或命令。忽略查询失败标记发现不完整、暂不登记该范围的新子 Git，继续寻找 CVS。发现排除不改变物理写边界或任何原扫描上限。

回归并入既有 grouping、catalog-discovery、repository-performance 与 commit UI 检查，由 `pnpm run test:headless` 执行。真实 Electron 的首屏采样、二十轮焦点／本地刷新、首次 Markdown 与浅深截图写在本轮 RECORD；均为合成夹具，不构成 M3 安装版、Windows 或公司仓验收。版本 0.6.11 只在授权本地分支提交，不改产品固定 URL、不推送或发布。
