# JetTortoise 工程说明

本仓扩展身份为 `jieyuexing.jettortoise`。现行开发分支 `restart` 于 2026-10-29 从上游 `32f7f5e`（0.4.17）建立（用户决定保留上游 Commit webview 和底部 Log 外壳，做多仓 Git/CVS），`main` 不动。版本只在 `package.json`，同时更新 `CHANGELOG.md`。M3 与台式机都有登记检出；每轮可改范围、是否启动 GUI、推送与发布由任务书决定，打包与发布流程见 [`docs/release.md`](docs/release.md)。提交身份用仓内 Git 配置（`jieyuexing@outlook.com`），不用 `git -c user.*` 等方式覆盖。

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

Git 与 CVS 每仓一次提交、各自排队，不把多个仓库承诺为一个原子事务。开始前验证全部所选根；逐仓失败会报告已经成功的仓库并保留说明。Git 先检查完整索引，再 `git commit -m <message> -- <paths>`，未选择的暂存内容保留；合并类操作进行中例外，见「合并中提交与分叉更新」。Amend 和 Commit and Push 只在单个 Git 仓选择中可用；Shelf/Stash 明示仅 Git。

一个 `kind + canonical root` 对应独立的服务、队列、watcher、快照、错误和修订内容访问权。当前编辑器只驱动底部 Log 的默认仓库；提交区明确选择的仓库优先控制 Update Project。Git 日志行在说明前显示分支/标签标记，说明保留完整文本并由行内布局在末尾省略，不修改原图或其它日志组件。CVS 日志默认是仓库级提交列表（见「CVS 仓库级日志」）；「当前文件」模式的文件历史只列所选文件的修订号、日期、作者和说明，点修订用原生 diff 比较上一修订。工作区 diff 为 Entries 的 BASE 与磁盘。

修订 scheme `jettortoise` 通过 `onFileSystem:jettortoise` 激活，恢复标签页的首次读取等待仓库发现；0.6.8 起，CVS 恢复修订页不自动连服务器，需显式重新打开差异才允许该会话读取相应修订。Git 的本地修订恢复不变。扩展另以 `onStartupFinished` 激活：Theia 1.76 只在视图展开时发 `onView`，布局恢复时已可见的 webview 视图不会触发，也不会像 VS Code 那样为 `contributes.views` 隐式补 `onView`，否则 ETECH Theia 里提交与日志视图空白。CVS 工作区 diff 使用动态 `BASE` URI，在每次队列读取时解析当前 Entries，标题不固定修订号；历史 diff 保持指定修订。提交、回滚和更新后，按仓触发已读取修订 URI 的文本与文件系统变更事件，并通知正显示该仓的 CVS 文件历史重新加载；其它仓不跟随刷新。嵌套边界拦截提示列出最多三个相对目录，余项显示 `and N more`。

CVS 登记、监听文件和焦点等自动路径只读 Entries/Entries.Log 本地段，不执行 CVS 命令；Git 自动路径只运行本地 status，不 fetch。用户显式刷新与已有写操作检查才在本地段之后运行 `cvs -f -n -q update`。焦点只读本地；保存只读该文件，保留最近确认的远端状态。网络结果为权威状态；网络开始前记录文件 mtime，只有其后 mtime 变化的文件才用本地结果覆盖。网络已确认干净的文件在 mtime 和修订号未变时继续保持干净，避免焦点刷新恢复假修改。网络失败保留本地快照并只在该仓显示错误。Git 沿用上游 watcher，每根独立；保存按真实物理归属判断。

**真实边界决定写权限，发现与展示不能解除边界。** 同项目但父 Entries 未登记的 CVS 目录不单列，也不进入父仓任何组，仍阻止父仓针对该目录的路径写入；CVS 已登记目录更新跳过它。连续 CVS 目录合并读取 Entries.Log。发现不越出工作区，不跟随目录软链；0.6.11 的目录忽略查询按下述大工作区合同，只运行固定的本地 Git 只读命令，不调用 CVS 或远端。最近真实边界即使未登记也保护文件，不回落祖先；子目录窗口不借用窗口外根。

文件修改重新检查归属和符号链接；Git 提交验证完整索引，包括已被父仓跟踪的子仓重叠。checkout/reset、merge/rebase、全量 stash、patch 沿用完整树预检，无法证明安全就拒绝。清单读取可在未管理目录停止，整树写预检不能使用这一优化。写操作在队列执行与确认后重新验证工作区可用性和信任；未保存编辑器阻止覆盖或提交。

Update Project 只更新当前分支 upstream，Git 固定 `pull --ff-only --no-rebase --no-autostash --no-recurse-submodules`，分叉不自动合并、变基或 stash；0.6.15 起分叉时由用户在通知里选择合并或变基，见「合并中提交与分叉更新」。CVS 从根开始合并各层 Entries 与 Entries.Log 的 A/R 记录，仅收集本地存在且带 CVS 的已登记目录；只对该集合预检异 Root/Repository checkout 与 Git 边界。用 `cvs -q update -l -P . <相对目录…>` 逐层更新，不带 `-d`，服务器新目录不会创建；每批按包含可执行路径、`-f`、引号、空格及终止符的 Windows 转义上界计长，不超过 8000 字符，所有批次共用一次写队列与取消信号。通知区进度可取消。取消不承诺已经应用的文件写入自动回滚。

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

`test:headless` 合并分组、发现、Git/CVS 内核与子仓、消息合同、快进更新和公共 Host 集成检查，使用真实临时 Git 仓、本地 bare remote、`:local:` CVSROOT 与模拟 VS Code API。包装后路径为 `release/jettortoise-<版本>.vsix`；打包已有 release 文件前先备份，打包后逐字节恢复并复核 SHA-256。

Headless、fixture 和构建通过不代表 VS Code 窗口交互、加载版本、安装、焦点、布局或 Windows CVSNT/公司环境验收。GUI 由协调者另行在隔离窗口验证，不从本任务自动安装、启用或发布。

## 工程资源命令（2026-10-30，0.6.1）

ETECH 工程右键通过公开命令 `jettortoise.updateProject`、`jettortoise.openCommitPanel`、`jettortoise.openHistory` 传入资源 URI；文件历史沿用 `jettortoise.showFileHistory`。新命令等待首次发现，再按资源的真实物理边界定位已发现仓库并核对工作区与信任；非法资源不回退到前一仓库。更新仍走原 request/update 队列、确认、可取消进度及 Git 快进／CVS 显式已登记目录规则。提交只选定所属仓并打开已有提交视图，不自动提交；工程历史清除旧文件选择；CVS 工程历史自 0.6.22 起显示仓库级提交列表，带文件的显示历史切到「当前文件」。提交面板原有消息与行为保持不变。

检查沿用 `pnpm run test:headless`，`scripts/restart-host-check.cjs` 覆盖资源选仓、无效/失信拒绝和公开入口的真实本地 CVS 更新。版本只改 package.json 与 CHANGELOG.md，候选不推送、不打标签、不发布。


## 长列表密度（2026-10-30，0.6.2）

B2 按用户给出的 IDEA 参照统一 Git 日志与图线、CVS 文件历史、提交文件行、分支与标签树为 22px。GitGraphSvg 与 CommitList 使用 CommitRow 导出的同一行高，避免图节点和虚拟滚动错位。字体通过 `--font-size` → `--vscode-font-size` 继承宿主，CVS 修订号使用宿主等宽字体，无底色徽章；表头与行的内边距一致。保留分组、勾选、消息和 VCS 行为，检查仍从原有 headless 入口执行。候选由产品仓隔离解包试用，不推送、不打标签、不发布。

## 提交与日志可见性（2026-10-31，0.6.3）

Webview 显示／隐藏只由宿主布局负责；提交 provider 不再据可见性变化打开日志或关闭底栏。只有显式打开提交、历史等用户操作触发对应 focus 命令。回归并入 `scripts/restart-host-check.cjs`，由既有 `pnpm run test:headless` 运行。ETECH B3 集成任务在隔离开发构建验证底部本地更改／日志，不改变原生 VS Code 容器声明、仓库消息和写入合同。

## 本地更改三态（2026-10-31，0.6.4）

用户已确认 [`docs/design/local-changes.html`](docs/design/local-changes.html)（“对 就应该是这样”），它是本节唯一视觉基准，覆盖旧版常驻提交表单与尺寸说明。删除上一轮未采用的弹窗提交方案，不合并 `b5-codex-wip` 界面。任务书允许本机产品开发构建试装，覆盖旧实验“不启动 GUI”的限制；不推送、不改安装版。

- 浏览默认没有复选框与提交说明。30px 竖排工具栏、22px 行、14px 层级增量；按更改列表→仓库→目录分组，浅色逐项采用底稿变量，深色映射宿主主题。Git 的更改／搁置／储藏小页签仅在树列存在 Git 仓库时出现；窄于 760px 改为横排工具栏与树。
- 单击文件请求 `getWorkingFilePreview`；双击沿用 `showDiffForWorkingFile`。预览 Git 比较 HEAD 与磁盘，CVS 比较当前 Entries 的 BASE 与磁盘；只读并排／统一视图共用滚动、行号与行内着色。中缝回滚入口打开已有完整差异，不新增文件写入通道。
- 有界读取沿用 comparison resolver：每侧 2MiB、20000 行，前端最多合计 8000 行、diff 150ms/2000 次编辑，行内比较最多 4000 字符。超限、二进制或（宿主没有编码 API 时）非 UTF-8 显示灰字（0.6.16 起按文件编码解码，见「环节 7 打磨」），过时请求不覆盖新选择。忽略文件不参与现有变更扫描，树保留折叠入口并明确说明，不伪造忽略文件计数；传入分组保留只读。
- Ctrl+K 或工具栏进入提交态：预选全部可提交更改，复选框出现在同一棵树，说明框在树下获得焦点；Esc 或提交成功返回浏览，失败保留说明。提交并推送与修改上次提交仍仅允许单个 Git 仓库选择，不改原命令与写队列。无仓库只显示“此工作区没有 Git 或 CVS 仓库”。
- CVS 只读查询（预览、文件历史、文件清单）的进度位置为状态栏，写操作保持可取消通知；由 `scripts/restart-host-check.cjs` 断言。
- `webview/src/commit/commit-ui.test.tsx` 由既有 `pnpm run test:headless` 执行，原生 Git/CVS 预览与请求拒绝继续放 `scripts/restart-host-check.cjs`。结构、模拟交互与实际开发窗口分别记录，Windows 与真实公司仓未实机。

## 方案 C 组件化（2026-10-31，0.6.6）

当前尺寸合同以组件目录 总仓 `.state/records/vscode-jettortoise-plugin/design/components.html`（含公司内容，不入本仓，仅 M3）为准，覆盖上文历史 22px 行高和 B5 的 14px 缩进。界面字号 12px，仓库、分组、目录、文件、Git 日志与图线、CVS 修订表、分支与标签树均为 20px；每级缩进 16px。浏览态根文件从 8px 内边距、12px 空箭头槽、4px 间距起排，文件项内图标仍 16px；提交态另加现有复选框，不能用历史 x=48 推断当前浏览态位置。

- 十个尺寸变量只在 `webview/src/shared/theme/variables.css` 镜像，名称和值与产品仓（总仓登记 id `etech-theia-ide`）的 `theia-extensions/etech-eclipse-layout/src/browser/style/tokens.css` 一致，改值两处同步。颜色只读 Theia 导出的 `--vscode-*`，本地更改浅色固定调色板已删除；编辑器／差异正文的代码字号仍沿宿主。
- `webview/src/shared/components/VerticalToolbar.tsx` 与 `PanelHeader.tsx`、`panel-chrome.css` 供本地更改和日志共用。竖列 30px、按钮 22px、图标 16px、间距 1px、上下 4px，短面板滚动且隐藏工具列滚动条，禁用 40%。日志沿用分支工具列原动作；标题行 28px、12px，PanelHeader 的可选标题能力保留，本地更改与日志都不传标题，避免重复宿主页签名称；保留更改／搁置／储藏小页签与仓库选择行为。变更树容器不画焦点外框，选中行只在树内焦点时使用活动选中色，离焦消费 inactiveSelectionBackground／Foreground；按钮、输入、文本框自己的键盘焦点保留。日志列表沿用主题变量的活动／非活动选中，不新增列表级焦点框。
- Git 图与虚拟滚动共享 `CommitRow.ROW_HEIGHT`，从 CSS 镜像变量读取，未加载 CSS 时按同合同回落 20；不更改数据与 VCS 写入通道。headless 的本地化入口检查尺寸镜像与无硬编码颜色。
- 本轮允许在产品开发构建临时解包候选，不改安装版、不推送、不发布。VSIX 为 `release/jettortoise-0.6.6.vsix`；Windows、141、真实公司仓仍未验收。

## D1 左侧本地更改（2026-11-02，0.6.7）

用户确认的窄栏底稿为 总仓 `.state/records/vscode-jettortoise-plugin/design/workbench-c.html`（含公司内容，不入本仓，仅 M3），三态仍沿用 [`docs/design/local-changes.html`](docs/design/local-changes.html)；本轮开发构建可临时加载候选，交回前恢复原插件，不推送、不发布、不改安装版。

- 现有 ResizeObserver 的小于 760px 布局改为单行「本地更改」、浅色文件数，以及刷新／提交／回滚／更多四个动作；删除旧窄栏整排工具按钮及常驻的更改／搁置／储藏页签，相关动作移入更多。宽布局保持原样。
- 窄栏只有变更树，双击文件继续在编辑器打开差异。浏览态不显示复选框和说明；提交态在同一棵树显示勾选，说明框在树下。无仓库保持灰字空态。动作仍走现有 bridge、选仓、确认和写入队列，没有新增 VCS 写通道。
- 产品控制容器位置与互斥显示；默认左侧本地更改、底部日志。仓库选择行使用已有 28px PanelHeader；真实 CDP 测得控件上／下留白 3.5／4.5px，文字居中误差 0.25px，无需改该行。

`pnpm run check-types`、`pnpm run lint`、`pnpm run build`、`pnpm run test:headless`、`pnpm run vsce:package` 均退出 0；新增窄栏交互用例先红后绿，headless 中 UI 共 9 项通过。实际加载版本、临时替换与逐文件恢复、截图及仓库发现排查见 总仓 `.local/tmp/etech-eclipse-ws/d1/RECORD.md`（M3 临时记录，可能已清理）。用户原工作区“没有仓库”与 `main*` 不一致未在四组合成仓复现，未据推断修改发现逻辑；Windows、141 和公司 SCM 未覆盖。

D1b（同为 0.6.7，2026-11-02）：按组件目录「3 面板标题行」将窄栏自有标题改为 10px 左内边距、28px 行高、12px／600／1.4 字体，与 Theia 原生项目标题分别实现且几何相同；更多／收起常显，刷新／提交／回滚在面板悬停或键盘焦点时出现。首行箭头从 8px 起排，后续层级仍加 16px，宽布局在该阶段沿用 6px；2026-11-04 按 D1b 与同角色一致原则统一宽窄布局为 8px。收起请求只允许固定空字段，通过已登记的 Theia 左面板命令或 VS Code closeSidebar 完成，不进入选仓或 VCS 写队列。既有 headless 入口覆盖两种宿主命令及额外字段拒绝，UI 用例覆盖收起入口；产品侧真实 CDP 测得标题左边距 10px、居中误差 0.398px、首行缩进 8px。测试、VSIX、实际加载版本、临时替换恢复与浅深色截图见 总仓 `.local/tmp/etech-eclipse-ws/d1b/RECORD.md`（M3 临时记录，可能已清理）。


## 大工作区刷新与渲染（2026-11-03，0.6.8）

用户 ETW-E1 决定打开与自动刷新不连网，所有仓库网络命令全局并发最多 2。`src/repositories/network.cjs` 在 CVS 进程及 Git fetch/pull/push/ls-remote/clone 执行边界共用；本地 Git 命令不占位，队列内再次核验存活与取消，保留每仓写队列。忽略文件写后仅本地刷新；显式添加、回滚、更新、提交保持原有操作合同。未查询服务器前没有传入状态是预期行为。

变更树在原 20px 行与 16px 缩进上展平可见模型，仅挂载视口和前后各 6 行；方向键、Home/End 按完整模型定位并挂载目标，折叠后夹紧滚动位置。文件勾选、懒展开、右键和预览沿用原动作。0.6.11 起，初始连接先传文件为空的仓库摘要与加载标记，随后分批传文件（见下文），覆盖旧版“初始连接仍传完整快照”；后续小变更通知发送 changed/removed 与仓元数据；前端直接消费通知，不为每条通知重新拉取全工作区。登记与选仓通知不携带文件。

数量上限的当前行为以「扫描暂停」一节为准，覆盖本节原来的逐仓通知和只能重开工作区恢复规则；写入仍独立验证真实边界，不能以停扫解除保护。检查并入既有 `pnpm run test:headless` 的 `scripts/repository-performance-check.cjs` 与 UI 用例，只有合成仓和本地进程，不连接公司服务。ETW-E1 授权合成工作区开发构建 GUI 验收，覆盖本页历史实验的“不启动 GUI”限制。


E1 远端入口补查：CVS 历史挂载、自动选文件与编辑器跟随的文件清单只读本地 Entries；0.6.21 起日志可见时按自动选中的文件查询远端历史，0.6.22 起该行为只在「当前文件」模式（见「CVS 仓库级日志」；默认「整个仓库」只在打开、选仓、切范围、加载更早、刷新时取一次），其余由文件选择、刷新历史或显式打开历史命令触发；写后历史刷新仍源于用户写操作。恢复的 CVS 修订 URI 不再直接取服务器；只有当前会话通过显式差异入口签发的 URI 才读取远端，保持队列内 BASE 解析、动态失效和独立边界预检。这是“打开不连网”优先于 0.6.0 自动恢复 CVS 内容的明确行为调整，没有新增控件。


E1 追加视觉决定（2026-11-03）：用户否定 6 万列表观感，以 `local-changes.html` 的交互和 `components.html`「2 树行」为准，不新增控件。树行统一基础内边距 8px（2026-11-04 按 D1b 与同角色一致原则更新，覆盖 E1 原 6px）、每级 16px、行高 20px／字号 12px，箭头槽 14px 内放 12px 箭头、间距 5px、右留白 8px；宽窄布局均使用 8px 树基础内边距。类别标题 600，仓库／目录／文件 400；仓库仍是逻辑分组，保留 CVS/Git 标签，不把单文件仓库合并。目录用既有灰色文件夹，文件图标 16px 读取当前安装主题：公开 `vscode.extensions` 贡献和 workbench.iconTheme，限主题目录内的图片，批量读取仅可视文件，浅深色由 webview 主题类选择；无图片主题时沿用已有图标回落。字体图标主题的字体渲染不在本次范围。仓库按自然名称排序并以类型、根路径确定同名顺序。文件选择的背景横跨整行，活动／离焦分别消费宿主 list.activeSelectionBackground／list.inactiveSelectionBackground，移除文件和树标签描边；提交表单与工具按钮保留焦点标识。文件名只占剩余宽度，过长省略，不挤走图标。


## CVS 按需同步（2026-11-03，0.6.9）

CVS 仓库按需同步，未同步不进入本地更改。工作区发现仅保留本地元数据与物理边界；0.6.21 起日志仍列出未同步仓并可查文件历史，见「日志默认列出 CVS 仓库」；未同步不读文件状态、不执行 CVS，Git 仍自动读取本地状态。资源管理器末组“与资源库同步”仅在含 CVS/Root 且上级无 CVS 的根目录出现，命令再次验证真实根、工作区与信任；打开本地更改和日志，先发布本地快照，再走既有全局并发 2 网络队列执行一次只读 update。未同步仓不参与刷新全部。

同步状态仅在内存；仓库行保留 20px／12px／16px 层级，在分支后显示本窗口最近同步时间。复用工具栏按钮，行尾 16×16 移除按钮悬停或键盘聚焦才显示。移除处置旧会话、取消排队工作并清除快照，重新扫描不会自动恢复。已同步仓文件事件继续仅刷新本地。底部提示高 24px、左距 10px、字号 12px、--dim 颜色、上边 1px --line，未同步计数归零隐藏；纯 CVS 未同步工作区同样显示提示。项目树装饰保持现状。

回归沿用 scripts/repository-performance-check.cjs、scripts/restart-host-check.cjs 与 commit-ui.test.tsx，并入现有 headless；合成夹具、红绿结果与真实窗口验收边界见本轮 RECORD，不将 headless 成功等同 GUI 验收。

2026-11-04 日志仓库及CVS文件历史刷新均复用shared/components/ToolbarButton与PanelHeader，按钮22×22、codicon refresh图标16px，中文tooltip/aria-label为“刷新”与“刷新文件历史”；同行下拉框垂直居中、按钮右距8px，回调与显式查询合同不变。既有Commit工具栏和树行入口改为从shared导入同一组件，不另建按钮样式体系。

## 扫描暂停（2026-11-04，0.6.10）

用户反馈「为什么上来就爆一堆错误」，要求不提高上限，并让超限状态留在仓库行。此决定覆盖 E1 的逐仓警告和会话内禁止手动扫描：真实 `SCAN_LIMIT`（10000 目录）或 `inventoryLimit`（20000 CVS 文件）保留已有文件、暂停自动重试，不弹通知；损坏边界和非法路径不再冒充数量上限，操作失败仍走既有错误通道。

- 本地更改的更改组保留干净暂停仓，同行依次为名称、Git/CVS 标签、分支、同步时间、文件数、dim 状态「仓库较大，已暂停自动扫描」，行尾动作依次为扫描、移除。窄栏按分支 → 同步时间 → 文件数 → 暂停状态 → 名称让位；辅助文字不足一字加省略号时整段隐藏，名称至少保留一字加省略号。标签和 `ToolbarButton` 的 22×22 扫描入口、16px refresh 图标不参与压缩；按钮 tooltip 与 aria-label 始终为完整暂停原因及继续扫描动作。树行仍为 20px，按钮居中。
- 固定请求 `scanRepository` 必须携带已登记 repositoryId，拒绝 cwd、root、network 等额外字段；重新核验工作区和信任后仅重试该仓的本地状态。若仍超限，保持暂停；规模减小后可恢复，无需重开窗口。它不是分页遍历，也不绕过原上限。未同步 CVS 不允许以扫描请求绕过 E2。
- 暂停也是完整快照的合法元数据：首次失败仍发首快照，后续 delta 比较暂停标记；仓库列表独立发布，不因超限清空。Git 自动状态使用 status -unormal 和变更路径祖先检查，不进入忽略目录或嵌套仓内部；递归写预检仍检查忽略树并在子仓根停止。发现独立仓库的遍历与状态扫描是不同入口，不把发现范围当作上限原因。
- 首个登记的仓库（0.6.21 起含未同步 CVS）即设为日志默认仓，不等待整个发现遍历结束；不覆盖用户后续选仓。台式机真实窗口曾出现下拉已有数百个选项、日志正文仍显示没有可用仓库，原因是首仓选择延后，不是数量上限清空列表。这只解释该日志空态，不能据此宣布 M3 左侧整块空白已定位。
- CVS 发现保留本地管理元数据，0.6.9 起未同步不调用 localStatus/inventory；按需同步之后才盘点。本节回归并入现有性能、CVS 边界与 UI 检查；GUI 只在任务指定隔离产品开发构建临时加载候选，不改固定下载地址、不推送、不发布。
- CVS 历史文件清单只读 Entries（0.6.21），不盘点、不占会话队列；已同步仓暂停期间清单为空，恢复后重新读取。真实读取失败仍保留具体错误。


## 大工作区首屏与保存监听（2026-11-04，0.6.11）

用户 2c 要求：六万变更文件、两千嵌套仓规模下，点击版本控制后一秒内显示实际可见的本地更改、仓库行与计数（允许加载中），保存监听不随仓库数增加；A/B 修复后复测 Markdown，不另改 Markdown 插件。

用户 2c 显示返工：加载状态只在仓库行计数位置显示一次，树中不插入游离加载行；文件分批到达时同一处显示“正在加载… N 个文件”，完成后恢复文件数。首屏尚无文件时只有分类和仓库行，不增加进度行，覆盖此前仓库行下再加独立加载提示的行为。

- manager 只注册一个全局保存事件，按词法根筛选后由 Git watcher 重验物理边界。独立 watcher 默认仍自行监听；manager 创建的会话关闭其保存订阅。父 Git 精确跟踪子仓路径时仍参与保存刷新，不把未登记子仓交给父仓写入。
- 本地 Git 状态最多同时运行四仓，同仓在途普通刷新共用一个任务。CVS 继续沿用本地／网络队列和按需同步，不占此 Git 槽位；焦点不查询服务器。仓库列表通知合并至 50ms，发现进度至 100ms；第一批根仍及时登记。
- 提交视图 HTML 通过既有转义 data 属性内嵌同一份无文件摘要，store 首次加载即消费，避免先绘制空列表再等一次 RPC；完整文件仍走原消息通道。`getRepositories`／`getRepositoryChanges` 的 webview 响应先返回文件为空的摘要，计数显示“正在加载…”。文件每批最多 5000 条、批间让出 16ms，最后一批恢复真实 refreshing。连接、仓库或新快照会取消旧批次，每次请求使用独立传输标记；初始响应等待期间更新的仓库使用最新快照继续传输。内部 manager 请求仍提供完整状态，提交、选择与写队列合同保持原样。
- 提交树继续只挂载可视行。日志右侧的文件树原来递归挂载全部文件，六万变更会生成约 24 万 DOM，阻塞共用渲染进程中的 Markdown；现在同样仅挂载视口及前后六行，树形／平铺、折叠、单击、双击、右键与状态色沿用原回调。共享树构建用路径 Map 与复用 Collator；其它使用者保持原展示方式。不可变仓库快照复用文件分组，单仓更新不重建其它大仓文件。
- Git 自动发现用固定 `git -C <root> ls-files --others --ignored --exclude-standard --directory -z`，设置 `GIT_OPTIONAL_LOCKS=0`、禁止终端凭据交互，限定缓冲、超时并支持取消。此用户决定覆盖旧发现“完全不调用 VCS CLI”的限制；不执行任意 Git 参数、配置写入或网络命令。依据 Git 原生目录忽略结果，忽略目录中的嵌套 Git 不自动登记；显式工作区根仍登记。VS Code Git 也提供 `git.repositoryScanIgnoredFolders`（默认 node_modules）和 `git.repositoryScanMaxDepth`（默认 1）限制自动发现；本插件保留 E2 的递归 Git 发现范围，不擅自改成 VS Code 的深度设置。
- Git 忽略只影响 Git 登记，不剪掉目录遍历：被忽略树中独立 CVS 仍读取管理元数据、提供按需同步入口，不启动 CVS 清单或命令。忽略查询失败标记发现不完整、暂不登记该范围的新子 Git，继续寻找 CVS。发现排除不改变物理写边界或任何原扫描上限。

回归并入既有 grouping、catalog-discovery、repository-performance 与 commit UI 检查，由 `pnpm run test:headless` 执行。真实 Electron 的首屏采样、二十轮焦点／本地刷新、首次 Markdown 与浅深截图写在本轮 RECORD；均为合成夹具，不构成 M3 安装版、Windows 或公司仓验收。版本 0.6.11 只在授权本地分支提交，不改产品固定 URL、不推送或发布。

## 本地模拟远端写入走通（2026-11-05，0.6.12）

ETECH 环节 7 写入部分用产品仓 `fixtures/vcs-sim/vcs-sim.py` 搭本机 CVS（`:local:` 与 127.0.0.1:2401 pserver）和 Git 裸仓库，在隔离开发构建里走通签出、本地更改与差异、更新、增删改提交、历史、冲突解决与 MS932 原字节往返。走不通的四处按最小改动修正，回归并入既有 `scripts/cvs-real-test.mjs` 与 `scripts/git-update-check.cjs`：

- `cvsRoot` 接受端口后直接接路径（CVS 1.12）与再带冒号（CVSNT）两种 pserver 写法；带口令的根仍拒绝。
- 已登记文件本地被删：本地状态 Missing 列为删除；网络 `update` 报 U／was lost 时保持本地删除。提交校验遇到磁盘缺失且 `cvs status` 为 Needs Checkout 的文件，先 `cvs remove` 再按 Locally Removed 提交。
- Entries 时间戳带 `+`（合并结果）时，文件 mtime 与 `+` 后时间相同才是冲突，否则为本地修改，与 CVS 自身判定一致；时间无法解析时保守视为冲突。残留冲突标记由 `cvs commit` 拒绝。
- Git 快进更新的本地更改检查排除 `.idea/shelf`（本插件搁置区），其余已跟踪改动与未跟踪文件仍按原合同拒绝更新。

未改：Git 更新仍不自动 stash。0.6.12 走查留下的其余缺口由 0.6.13 补上，见下节。

## 环节 7 缺口（2026-11-05，0.6.13）

- 修订编码：`RepositoryManager.readFile` 取得修订字节后，按右侧工作文件解码：已打开的文档有 `encoding` 时用它，否则调 `workspace.decode(内容, {uri: 工作文件})`，由 IDE 按设置决定编码（ETECH 产品的 EncodingRegistry 读 Eclipse 工程 prefs）。解码后再用 `workspace.encode(文本, {uri: 修订 URI})` 写回成 IDE 读取修订 URI 的编码，两侧一致。Git 与 CVS 共用这一处。宿主没有这两个 API（VS Code 1.100 以前）或内容含 NUL 时原样返回。不在扩展里另行解析 prefs，以免与 IDE 的优先级（重新打开、文件夹设置）分叉。单击预览在 0.6.16 起同样按工作文件编码解码，见「环节 7 打磨」。
- 合并冲突：分组模型新增 `conflicts`，冲突文件只出现在置顶的「合并冲突」分类，有冲突时才显示，默认展开，不计入更改。Git 冲突行右键为「标记已解决」，即 `stageFile`。`mergeContinue` 使用 `commit --no-edit --cleanup=strip`。
- CVS 传入：`status()` 把 `cvs -n update` 的 `U` 新文件（本地不存在）列为 Needs Checkout，本地刷新沿用最近一次网络结果。`update()` 返回本次的冲突文件并清空旧网络结果。工作副本有未解决冲突时 `cvs -n update` 退出码为 1，只在输出含 `C ` 行且没有 `aborted]` 时接受，其余仍按命令失败处理。
- CVS 冲突通知：更新返回冲突时弹一条警告，写明数量，「查看冲突」选中该仓、聚焦提交视图并广播 `revealConflicts`，变更树展开并滚到该仓的冲突行。本地清单按 CVS 默认忽略规则跳过 `.#*` 备份。
- 新签出发现：manager 监听 `**/CVS/Root`、`**/.git` 的创建事件。新目录不是已登记根，且（对 CVS）上级目录不是 CVS 目录时，防抖 500ms 后执行一次完整 `scan()`，与重开窗口时的发现相同。

回归：`scripts/cvs-real-test.mjs`（传入、冲突返回、`.#`）、`scripts/git-update-check.cjs`（标记已解决后继续合并）、新入口 `scripts/vcs-host-check.cjs`（编码、通知、发现，并入 headless），以及 `commit-ui.test.tsx`（冲突分组、定位、右键）。

## 日志历史差异（2026-11-05，0.6.14）

GWH 只读副本（`--depth 1` 浅克隆，根提交 52692 个文件）在 0.6.11～0.6.13 里，日志变更文件右键「显示差异」和双击都没有反应。根因：webview 打开差异时把整个提交的文件列表作为 `fileList` 回传，供上一个／下一个导航；宿主消息合同对 `diffFiles` 限 10000 条，于是请求以“请求字段无效：fileList”被拒。webview 把 Error 对象直接交给 `console.error`，宿主转发日志时序列化成 `{}`，界面也没有通知。浅克隆缺父提交不是原因，resolver 对无父提交本来就给空左侧。

- `openDiffEditor` 只传提交、所选文件与可选的多选提交；导航列表由 Git 会话按提交（多选时按各提交合并）用 `getCommitRangeFiles` 列出，与 webview 显示的变更文件同源同序。协议去掉 `fileList` 字段与只为它存在的 `diffFiles` 规则，单个 `diffFile` 校验不变。推送面板打开差异同样获得导航列表。
- `webview/src/shared/bridge/report-error.ts` 的 `reportError` 把失败原文写成 `<动作> failed: <原文>` 并经 `showErrorNotification` 弹出；日志里的打开差异、编辑源、打开仓库版本使用它。CVS 文件历史的失败仍在面板内显示原文。
- CVS 历史差异只传文件与修订号，没有列表上限问题；本地模拟 CVS 的 1.1↔1.2（MS932）、1.1↔1.1.1.1、空↔1.1 均已在开发构建打开。

回归：`scripts/vcs-host-check.cjs` 用 10001 个文件的提交，断言不带列表也能打开差异、下一个跟随提交文件顺序；`commit-ui.test.tsx`「日志历史差异」断言请求不含 `fileList`、失败写日志原文并通知。

## 合并中提交与分叉更新（2026-11-05，0.6.15）

M3 安装版 0.6.13 在本地模拟 Git 远端上走查（ETECH 环节 7 串联）发现四处：合并解决冲突后在提交区点「提交」报 `fatal: cannot do a partial commit during a merge.`，只能点横幅无文字的继续按钮且说明不被采用；分叉时更新项目抛 git 英文原文；日志分支右键合并连弹两次确认；横幅按钮悬停无提示。

- 提交：`commitPaths` 发现 `MERGE_HEAD`、`CHERRY_PICK_HEAD` 或 `REVERT_HEAD`（`rev-parse --git-path`，worktree 也适用）时，完整索引检查不变，先 `git add -- <所选路径>`，再不带 pathspec 提交整个索引；有说明用 `-m`，说明为空用 `--no-edit --cleanup=strip`（Git 生成的说明，去掉 `# Conflicts:` 注释）。未选文件里已暂存的合并结果同样进入合并提交，这是 Git 对合并提交的要求。空说明只在这三种状态下被 Git 会话接受；请求合同与 manager 只校验形状，选中含 CVS 仓时仍要求说明。提交区按合并状态（0.6.16 起取自快照，见「环节 7 打磨」）放开空说明，占位文字提示留空用默认说明；cherry-pick、revert 的空说明宿主可接受，但提交区按钮只在合并时放开。
- 分叉：`updateFastForward` 的 pull 失败且 `HEAD...@{upstream}` 两侧都有独有提交时，不再抛原文，返回上游名与两侧提交数（工作区不变）；其他失败与取消保留原文。manager 像 CVS 冲突通知一样不等待地弹警告，写明数量并提供「合并」「变基」；选择后在同一写队列里检查未保存编辑器，先把 `@{upstream}` 解析成上游名（如 `origin/main`，冲突标记与说明显示真实分支），再执行 `git merge --no-edit <上游>` 或 `git rebase <上游>`。有冲突时保留进行中状态并沿用「更新项目：N 个文件有合并冲突」通知与合并冲突分组；无冲突的其他失败弹错误原文。分支右键「更新」（`pullBranch`）分叉时报同一中文说明，不给动作。
- 合并确认：分支右键合并不再在 webview 先问一次，只保留宿主 `mergeBranch` 的模态确认，文字写明合并到当前分支。变基、删除分支等其他入口的双重确认由 0.6.16 统一，见「环节 7 打磨」。
- 横幅：变基、拣选、合并横幅的图标按钮改用原生 `title` 与 `aria-label`（与 `ToolbarButton` 一致），不再包自绘 Tooltip（M3 走查中自绘 Tooltip 悬停无提示，原因未单独排查）。

回归：`scripts/git-update-check.cjs`（合并与 cherry-pick 中按路径提交、空说明默认合并说明、非合并空说明拒绝、分叉返回、合并／变基、合并冲突），`scripts/vcs-host-check.cjs` 第 7、8 节（分叉通知选合并、冲突通知后空说明提交），`commit-ui.test.tsx`「合并进行中」（横幅提示、空说明提交、非合并禁用、合并只确认一次）。

## 环节 7 打磨（2026-11-05，0.6.16）

M3 安装版 0.6.15 复测（ETECH 环节 7）留下六处：解决结果与本地相同时文件不在本地更改里，只能经横幅继续合并；变基、删除分支等仍确认两次；冲突时日志 `Merge failed: {}`；提交超过 2000、回滚超过 10000 个文件被拒；单击预览只认 UTF-8；合并中留空说明只在台式机开发构建测过。

- 合并进行中：Git 快照带 `merging`（`rev-parse --git-path MERGE_HEAD`）。冲突都已解决后，更改组在该仓没有文件时仍列出仓库行，行内 dim 状态「合并进行中，提交即完成合并」；工具栏「提交」在没有可提交更改但有合并时可用，提交区在合并中允许空说明与空选择。空选择时 `commitRepositories` 带 `repositoryId`、`files: []`，manager 只接受该 Git 仓快照为合并中，`commitPaths` 不暂存、直接提交索引（说明空则 Git 默认说明）。webview 的合并状态改由快照决定（合并中且没有冲突文件，提交区所选仓优先），横幅只负责显示与继续／中止，不再写提交区状态。
- 确认：破坏性操作只由宿主模态确认一次，webview 不再先问。宿主文字写明对象与后果：变基（当前分支、目标、本地提交将被重写）、检出并变基、删除本地／远端分支、强制删除（未合并提交将丢失）、硬重置（当前分支、目标、未提交更改将丢弃）、丢弃提交、强制推送（远端／分支、远端多出的提交将被覆盖；`pushBranch`／`executePush` 在 `force` 时才确认）。删除分支先按普通删除确认；git 报未完全合并时由 webview 发起强制删除，宿主再确认这一不同后果。修订文件还原与应用沿用宿主确认。修改上次提交后的强推在 0.6.18 补上确认，见「环节 7 遗留」。
- 失败原因：`GitService` 的合并、变基、检出并变基、分叉后合并／变基与更新项目失败时，有冲突写“<动作>失败：N 个文件有冲突，首个为 X”，否则取 stderr（其次 stdout）第一条 `error:`／`fatal:` 行；取消仍保留原错误。日志分支与提交右键的 git 写操作失败统一经 `reportError` 写日志并弹通知。
- 大批量：Git 提交、暂存与回滚用 `--literal-pathspecs … --pathspec-from-file=- --pathspec-file-nul`，路径经标准输入一次传给 git；回滚先 `ls-tree HEAD` 一次区分已跟踪与新增，前者一次 `checkout HEAD`，后者一次 `rm --cached` 再删文件。`checkedPaths` 与 manager 提交校验对整批路径调用一次 `boundariesForPaths`（同次缓存），目录目标仍走完整嵌套检查。消息合同 `path[]`、`rollbackFiles` 与 manager／请求合同去掉 2000／10000 条上限。CVS 提交先一次核对清单与子仓边界，再按 8000 字符分批 `cvs -n -q update <文件…>` 取状态（代替逐文件 `cvs status`）、分批 `cvs remove` 本地已删文件、分批 `cvs commit`（说明不计入批长度）；每批是一次 CVS 提交，CVS 本身不是原子事务。CVS 回滚在本版仍逐文件取 BASE 修订内容并留备份，只去掉条数上限（台式机开发构建一次 12000 个文件约 23.7 分钟，期间 webview 请求超时、备份列为未受版本控制）；0.6.18 起改为分批 `update -C`，见「环节 7 遗留」。完成通知最多列三个备份名，其余写“另有 N 个”。浏览态变更树新增 Ctrl+A 选中全部更改（不含传入与未受版本控制），工具栏「回滚」按选中文件工作，此前没有一次选中上万个文件的入口。
- 预览编码：comparison resolver 两侧都调 `decodeAsWorkingFile`（与 0.6.13 修订内容同一函数：已打开文档的编码优先，否则 `workspace.decode(内容, {uri: 工作文件})`），宿主没有该 API 时回落严格 UTF-8。

回归：`scripts/git-update-check.cjs`（空选择合并提交、合并／变基／更新失败摘要、12000 个文件暂存／提交／回滚并输出耗时）、`scripts/vcs-host-check.cjs` 第 9～12 节（CVS 回滚通知只列三个备份名、快照合并标记与空选择提交、Git／CVS 预览 MS932、10001 个文件经 manager 提交与回滚）、`scripts/message-security-check.cjs`（12000 条路径、强制推送确认一次）、`scripts/cvs-real-test.mjs`（2500 个文件分批提交含一个本地删除）、`scripts/cvs-nesting-check.mjs`（所选文件状态查询不做整树 update），以及 `commit-ui.test.tsx`「合并进行中」「破坏性操作只确认一次」「合并失败原因」「大批量回滚」。

## 环节 7 遗留（2026-11-05，0.6.18）

0.6.16 留下两处：CVS 回滚逐文件执行，12000 个文件约 23.7 分钟、期间面板请求超时、备份列为未受版本控制；修改上次提交后的强制推送没有确认。

- CVS 回滚：`CvsAdapter.rollback(names, signal, progress)` 先一次核对子仓边界与清单（新增、已删除登记的文件没有可恢复修订，全部校验通过才写），再用提交同一个 8000 字符 `batches()` 分批 `cvs -q update -C ./<文件…>`。本地修改由 CVS 改名为同目录 `.#<文件>.<修订>`，原 `.jettortoise-backup-*` 与逐文件 `log`／`update -p` 删除；返回实际存在的备份相对路径，完成通知仍最多列三个。`update -C` 取分支上的资源库副本：服务器已有新修订的文件同时更新到新修订（本机 CVS 1.12.13 实测），确认框写明；`-r BASE` 会写入粘性标记 `TBASE`，因此不用。本地被删的已登记文件同样恢复。
- 不阻塞请求：`CvsSession.rollback` 先在队列外模态确认，返回 `{ done }`；manager 不等待 `done`，面板请求立即返回，回滚在队列内重新核验工作区、信任与未保存编辑器后进入可取消的通知进度，每批报告「N / 总数 个文件」，失败经错误通知显示，结束后刷新并触发修订失效。`operate` 的动作回调因此多收一个 `progress`。
- 忽略表：`cvsIgnored` 使用 CVS 1.12 内置忽略表（ignore.c 的 `ign_default`），本地清单的未管理文件与目录、按文件刷新的 untracked 判定共用；与 `cvs -n update` 的 `?` 行逐项对过。本版不读 `.cvsignore` 等用户层规则；0.6.19 起读取，见「CVS 忽略规则」。
- 修改已推送的上次提交：`GitService.amendedRemoteCommit` 只在分支 reflog 最近一条为 `commit (amend)` 且 `<分支>@{1}` 正是远端跟踪分支时返回被替换的提交；没有 reflog 或远端另有提交都不算。`getAheadCommits` 带回该值，推送面板目标分支与本地同名时主按钮改为「强制推送」，发 `force: true` 走原 `executePush` 宿主确认一次；确认文字写明被替换的远端提交，并说明远端在上次获取后有变化时 `--force-with-lease` 会拒绝。确认被取消时面板保持打开、不再提示“已推送”。旧 `commitAndPush` 消息只在同一条件下强制推送并先确认，拒绝则只保留本地提交；`GitService.commitAndPush` 删除。普通推送被拒仍沿用原“推送被拒绝”对话框。

回归：`scripts/cvs-real-test.mjs`（2499 个文件分批 `update -C`、进度、备份不列出、忽略表与 `cvs -n update` 一致）、`scripts/vcs-host-check.cjs` 第 12、13 节（`openRollbackPanel` 不等回滚完成即返回、`.#` 备份名通知；修改已推送提交后 `getAheadCommits` 报告、强制推送确认文字、旧 `commitAndPush` 拒绝后远端不变、普通提交并推送不确认）、`scripts/restart-host-check.cjs`（后台回滚后的修订失效与 `.#` 备份），以及 `commit-ui.test.tsx`「修改上次提交后推送」。真实窗口的耗时与截图写在本轮 RECORD；Windows CVSNT、pserver 下的大批量与公司仓未覆盖。

## CVS 忽略规则（2026-11-05，0.6.19）

M3 安装版 0.6.18（AM 轮）：工程 `.cvsignore` 写了 `.gradle`，`cvs -n update` 不报它，本地更改的未受控列表却列出 `.gradle`。0.6.18 的本地判定只用内置表。

- 规则：`src/cvs/core.mjs` 按 CVS 1.12 客户端（ignore.c 的 `ign_setup`）顺序叠加内置表 → `~/.cvsignore`（家目录先取 `HOME`）→ 环境变量 `CVSIGNORE` → 各目录自己的 `.cvsignore`；目录规则只作用于该目录下的名字，不继承到子目录。规则按空白切分；单独的 `!` 清空此前规则（仍保留 `CVS`），目录里的 `!` 只影响该目录。模式按无标志 `fnmatch`：`*`、`?` 也匹配开头的点，方括号支持 `!`／`^` 取反与范围，反斜杠转义；无效范围不匹配任何名字。0.6.20 起支持 C locale（ASCII）的 POSIX 字符类：`alpha`、`digit`、`alnum`、`upper`、`lower`、`space`、`blank`、`punct`、`xdigit`、`cntrl`、`print`、`graph`，可与普通字符、范围、取反和转义组合（如 `[![:digit:]]*`、`[[:alpha:]_]`）。未知小写类不匹配，写在未知类之前的正向成员仍可匹配（`[a[:unknown:]b]` 只匹配 `a`）；取反未知类不匹配，按本机 CVS 1.12 的 fnmatch 实测。本地清单的未管理文件与目录、按文件刷新的 untracked 判定共用；未管理目录按其所在目录的规则判断。
- pserver：客户端未忽略的名字再由服务器按它自己的表（内置表与 `CVSROOT/cvsignore`）判断，目录 `.cvsignore` 里的 `!` 清不掉服务器的内置表；只有 `~/.cvsignore` 或 `CVSIGNORE` 里的 `!` 让服务器也不忽略。因此 `:pserver:` 根在目录有 `.cvsignore` 且全局没有 `!` 时，末尾再并上内置表（vcs-sim pserver 实测）。
- 不读服务器端 `CVSROOT/cvsignore`：pserver 下要连网，`:local:` 下为与 pserver 一致也不读。它只在网络刷新的结果（`?` 行）里生效，之后的本地刷新仍会列出这些文件。
- 缓存：规则文件按路径缓存模式与编译后的匹配器，mtime、ctime 或大小变化即重读，删除即失效；`~/.cvsignore` 与 `CVSIGNORE` 每次清单读一次。清单只在目录列表里有 `.cvsignore` 时才读它，没有时直接用全局匹配器。读不到的规则文件按不存在处理（CVS 只警告后继续）。
- 环境：`CvsProcess` 清除 `CVS*`／`RCS*` 环境变量时保留 `CVSIGNORE`，网络刷新与本地清单用同一套规则。

回归：`scripts/cvs-real-test.mjs`（12 个 POSIX 字符类及组合、未知类与控制字符，三层目录、`!`、`~/.cvsignore`、`CVSIGNORE`、改写与删除 `.cvsignore`，本地清单、按文件刷新、网络刷新都与同一时刻 `cvs -f -n -q update` 的 `?` 行逐项比较）、`scripts/cvs-nesting-check.mjs`（`:pserver:` 根目录 `!` 不清服务器内置表、全局 `!` 才清）。vcs-sim（`:local:` 与 pserver）上的逐场景对比与 6 万文件清单改前改后耗时写在本轮 RECORD。Windows CVSNT 的家目录、大小写与服务器端忽略语义未覆盖。

0.6.20 边界：字符类固定为 ASCII；匹配器仍按 JavaScript UTF-16 单元匹配，未扩展为完整的 C locale UTF-8 字节匹配（例如无后续通配符的取反括号匹配非 ASCII 文件名时可能与 CVS 不同）。方括号里的 `\]` 在 macOS Homebrew CVS 1.12.13 上与 Linux 不同（`[A\]]` 只忽略 `]`），插件按 Linux 行为，回归在 macOS 上跳过该例。Windows CVSNT 与安装版界面未验。

## 日志默认列出 CVS 仓库（2026-11-10，0.6.21）

用户 11-10：“默认打开 cvs 仓库的时候 不会显示仓库的历史”（产品决定见 ETECH 仓 `ETECH.md`「版本控制按需同步与打开速度」）。此节覆盖「CVS 按需同步」中“同步后才进入日志”和 E1 的“挂载不查远端历史”。

- 仓库列表分两份：`repositories`（Git 与已同步 CVS）只供本地更改、快照、扫描、刷新与写操作；`logRepositories`（全部已发现仓库）只供日志下拉。`unsyncedCvsCount`、未同步提示、按需同步和移除同步的含义不变，查看历史不算同步。
- 日志默认仓：首个登记的仓库，扫描结束仍无有效选择时取 `logRepositories` 第一项；当前编辑器文件所在仓库优先（含未同步 CVS）。移除同步不改日志选择。
- 提交面没有明确选仓时沿用日志所选仓；日志选中未同步 CVS 时，宿主 `commitFallback()` 与 webview `commitTarget()` 都改用 `repositories` 第一项，提交面请求、Update Project 与命令面板 Git 命令不会落到未同步仓。
- 未同步 CVS 只放行日志的只读入口：`selectRepository`（surface 为 log）、`getCvsFiles`、`getCvsHistory`、`diffCvsRevision`、CVS 修订 URI 的 `readFile`（仍要求本会话显式差异签发），以及 `openHistory`／`showFileHistory`。`scanRepository`、`updateProject`、`openCommitPanel`、提交、回滚、预览等仍报“请选择可用的仓库”。
- 文件清单 `CvsAdapter.entryNames()` 沿 Entries 的 `D/` 记录走已登记目录（`registeredCvsDirectories`，与 update 的目录集合相同，子仓边界不进入），只读 Entries/Entries.Log 的文件行，不 lstat 文件、不执行 CVS、不改会话快照。目录超过 10000 个时返回空清单；文件数不设上限（上万个文件时下拉选项多，渲染较慢）。
- CvsHistory 挂载或当前编辑器文件变化后，文件清单选中当前文件，否则保留原选择，否则首个文件，并查询其历史。0.6.22 起仅「当前文件」模式如此，默认的「整个仓库」模式切换编辑器文件不查询。日志 webview 隐藏时保留上下文，可见性初值写进 HTML 的 `data-visible`，之后由宿主 `onDidChangeVisibility` 发 `viewVisibility` 事件；隐藏期间只记下待查文件，显示后再查。显式打开历史只查一次。

回归：`scripts/repository-performance-check.cjs`「日志列出未同步 CVS」（假 cvs 记录调用，清单不调 CVS、不读本地状态，提交面请求拒绝未同步仓并回落到 Git）、`scripts/vcs-host-check.cjs` 第 0 节（真实 `:local:` CVS，未同步下取清单、修订列表与两侧修订内容；argv 包装记录只有 `log` 与 `update -p`，同步后出现 `-n update` 作对照）、`scripts/restart-host-check.cjs`（日志视图可见性初值与事件）、`commit-ui.test.tsx`（日志下拉含未同步仓并显示历史、隐藏时等待、显式打开只查一次、提交面回落）。真实窗口、Windows CVSNT 与公司 CVS 未验。

## CVS 仓库级日志（2026-11-10，0.6.22）

用户 11-10 看了 0.6.21 只能按单个文件看履历后不满意，认可样图后改为：底栏「日志」对 CVS 仓库是仓库级提交列表。产品侧记录在 ETECH 仓 `ETECH.md`「版本控制按需同步与打开速度」。此节覆盖 0.6.21 的“CvsHistory 挂载即查文件历史”，其余 0.6.21 规则（`logRepositories`、未同步 CVS 的只读放行、提交面回落）不变。

- 取数：`CvsAdapter.repositoryLog({from, to})` 沿 `registeredCvsDirectories` 用 `cvs -f log -l -N -S [-d 范围] . <目录…>` 逐批取（与 update、文件清单同一目录集合，8000 字符分批，不进入嵌套或异 Root 的检出），只读 stdout。`-d` 用 UTC 的 `>=`／`<=`／`A<=B`（含两端）。单次输出上限 128MiB、超时 5 分钟，超出报“CVS 日志过大”；「全部」在大仓可能触及，由用户改选范围。
- 解析与分组在纯模块 `src/cvs/log.mjs`：日志按字节读入，作者、路径、说明逐条解码（严格 UTF-8，不合法再按 MS932）；日期兼容 `2026-11-10 12:08:39 +0800`（CVS 1.12）与 `2026/10/28 08:02:03`（旧版本，UTC）。有 commitid 按 commitid 分组；没有时按时间升序，同作者同说明、与组内最近一个修订相差不超过 `COMMIT_WINDOW_SECONDS`（60）、且该文件尚未在组内就并入，否则另起一组（链式窗口，同一文件不会在一个提交里出现两次）。有无 commitid 的修订不互相并入。导入产生的 1.1 与厂商分支 1.1.1.1 共用 commitid：文件取主干修订，说明取导入时写的那条；分支上新增文件时主干留下的 dead 1.1 只是占位，不算删除。提交按最近一个修订的时间倒序；文件的“上一修订”按修订号推算（主干减一、分支首修订回到分支点）。
- 缓存与时机：`CvsSession.repositoryLog(days, refresh)` 在宿主缓存原始修订和已覆盖的天数（0 为全部）；已覆盖的范围不连服务器，更大的范围只取缺的那一段（`from<=to` 含两端，按文件＋修订号去重）并整体重新分组，所以跨窗口边界的提交不会被拆开；刷新丢弃缓存重取。webview 只在日志可见时、且在首次打开、切换范围、加载更早、点刷新时请求；`follow()` 切换编辑器文件、`repositoryWritten` 都不请求。写入（提交、更新、回滚）后宿主使缓存失效，已显示的列表保持，下次打开或刷新才重取。切换编辑器会把日志选中的仓库切到文件所在仓库，首次选中另一 CVS 仓库按“选中该仓库（首次）”取一次。
- 协议：`getCvsLog {days, refresh?}` 返回 `{days, commits:[{id,time,author,subject,body,fileCount}]}`，`getCvsCommit {commitId}` 返回该提交的 `{path,revision,previous?,kind}`，取自宿主最近一次列表，不连服务器；两者与 `diffCvsRevision` 同属未同步 CVS 可用的只读入口。`days` 为 0～36500 的整数。
- 差异：`diffCvsRevision` 不变，`CvsAdapter.log()` 的路径门由“文件在 Entries”放宽为“所在目录是已登记的 CVS 目录”（`revisionFile()`，仍检查工作副本内、无符号链接与嵌套边界），所以同事新增的文件、已被删除的文件（dead 修订内容为空）也能打开两修订差异。
- 界面：标题行是仓库下拉、[整个仓库｜当前文件]、[近 N 天｜全部]、刷新（22px `ToolbarButton`，在仓库模式下只刷新日志）；主体左右两栏，左栏日期／作者／说明／文件数列表（20px 行，定高虚拟渲染）与底部「加载更早…」，右栏所选提交的标题、元数据与文件行（右侧 `1.7 → 1.8`／`新增 1.1`／`删除 1.4`，单击打开差异，右键「显示该文件历史」切到「当前文件」并选中它，文件可以不在本地 Entries）。默认选中最新一行；方向键移动。「当前文件」沿用 `CvsHistory`。显式显示历史：带文件（项目树右键）切到「当前文件」，工程级（`jettortoise.openHistory`）留在「整个仓库」；编辑器切换不改模式。
- 未覆盖：Windows CVSNT 与 pserver 下的 `-d`／`-S`／`-N` 行为未验；大量目录（数千个已登记目录）时 `cvs log` 分多批、每批一次连接；「全部」输出过大时只有报错，没有分页；日志里说明含整行 `----------------------------` 后接 `revision` 行时会被误切（CVS 日志格式本身无转义）。

回归：`scripts/cvs-log-check.mjs`（解析、分组、范围参数、合并，纯函数）、`scripts/cvs-real-test.mjs`「repository log」（真实 `:local:`：未同步副本里看到同事提交、新增与删除、MS932 说明、`-d` 范围、不在 Entries 的文件的修订与 dead 修订）、`scripts/vcs-host-check.cjs` 第 00 节（argv 包装记录：打开日志只有带 `-d` 的 `cvs log`，缓存、更早范围与刷新各一次，切换编辑器零调用，无 `-n update`）、`commit-ui.test.tsx`「CVS 仓库级日志」。
