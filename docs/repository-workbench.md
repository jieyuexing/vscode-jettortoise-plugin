# 仓库列表与 diff 工作台

> **改版进行中（用户 2026-10-28）**：交互改为参照 IntelliJ IDEA 的 Git，Git 与 CVS 由 JetTortoise 统一接管「源代码管理」视图，设计与切片见文末「改版设计」。改版上线前，本文其余部分描述的仍是现行行为。

本说明描述仓库列表的发现与保存、针对单个仓库的更新，以及只读 diff 工作台的布局与比较规则。

## 仓库列表与保存

Host 在受信任的本地工作区文件夹内后台扫描各层 Git/CVS 元数据。遇到父仓继续向下；不按 `.gitignore`、`node_modules` 等名称省略目录。不进入 `.git`、`CVS` 管理树，不跟随目录符号链接，也不向当前窗口外的祖先扩展。Git 指针文件可识别；连续 CVS 子目录仍属于同一工作副本，独立 checkout 单列。

扫描并发限制为 8（实现最多 16），逐步推送结果，可在列表或进度中取消。权限失败、消失目录和取消会保留已有登记并标记未完成；发现只读本地元数据，不调用 Git/CVS CLI，不 fetch、pull、status 或 update，不提前创建所有仓库的服务和 watcher。开始操作时仍执行原有客户端验证。

`repositoryRegistrations` 是唯一登记保存入口，属于当前 VS Code workspaceState。v2 在 v1 基础上保存自动/手动来源、隐藏项、分支/标签显示值及扫描状态；沿用类型与真实根路径生成的 ID。移除只隐藏登记、禁止新操作，不删除目录、历史或页面状态；重新扫描不会解除隐藏。通过“恢复隐藏仓库”或重新手动添加恢复。临时不可用的手动项保留。

关闭 `jettortoise.autoDiscoverRepositories` 不删除已有列表，仍可执行 `jettortoise.scanRepositories`。自动发现默认开启；启动、工作区文件夹变更和重新启用后运行。保存格式的读写、重建与隐藏恢复已有无窗口回归；真实关闭/重开同一 VS Code 工作区尚未执行。

## 目标仓库与更新

每个仓库仍有独立标签页。列表单击打开/聚焦那个仓库，右键更新其它仓库不会改变当前页面的绑定、草稿或选择。管理通道只接受 Host 已登记的 ID 和固定操作；普通消息仍属于原标签，客户端不能指定 cwd。手动添加和恢复使用 Host 对话框。

Git 更新当前分支 upstream，命令固定为：

```text
git pull --ff-only --no-rebase --no-autostash --no-recurse-submodules
```

执行前和队列实际运行时重新检查仓库、信任、未保存编辑器、工作区/索引、upstream、分离 HEAD、进行中的 Git 操作及嵌套边界。分叉由 `--ff-only` 拒绝，不自动制造合并提交、变基或 stash。Git 内核仍可能调用本机既有 hooks、过滤器及凭据助手。该行为依据 [Git pull 文档](https://git-scm.com/docs/git-pull/2.50.0)。

CVS 更新复用已有串行队列、超时、取消和错误脱敏。无法证明安全的父仓全量写操作继续被子仓边界拒绝。结果显示在目标行；失败保留错误，不能把失败更新报告为成功。取消不保证客户端尚未完成部分文件写入，应刷新确认。

## 布局与比较

第一栏上方为仓库列表，下方为当前仓分支/文件导航；第二栏为提交区；右上为只读 diff，右下为历史与详情。默认宽度为 220 / 280 / 260 px，diff 为右侧高度的 55%。分隔线可拖动并支持键盘调整；窄窗口优先临时收起详情，再收起导航，恢复按钮保留。临时响应式折叠不覆盖用户偏好。diff 展开覆盖整个工作台，恢复时继续使用挂载中的提交区与历史。

最近一次明确选择的工作区文件或历史文件控制 diff，来源标签可区分。后台刷新只重取该选择，不切换源或清空草稿。请求 ID 与页面生命周期阻止迟到结果覆盖新选择。每页单一状态写入器保存布局、历史、diff 模式及选择引用，不保存文件正文。Git 草稿只在页面内存中，CVS 沿用其已有草稿保存策略。

| 比较 | 左侧 | 右侧 |
| --- | --- | --- |
| Git 已暂存 | HEAD（重命名前路径） | index（新路径） |
| Git 未暂存 | index | 磁盘工作区 |
| Git 历史 | 父提交、显式基线或所选范围起点 | 所选提交/范围终点 |
| CVS 工作区 | Entries revision | 磁盘工作副本 |
| CVS 历史 | 所选 revision | 磁盘工作副本 |

新增、删除使用明确的空侧；原生和内嵌入口共用比较解析。CVS 内容读取单独保留 stdout，不把诊断输出混入文件。预览为只读，提供左右/行内、行号、已有 Shiki 语法高亮、同步滚动、差异跳转和原生 diff/打开文件入口。未保存编辑器有提示，预览实际读取磁盘。

每侧预览最多 2 MiB、20,000 行；二进制、超限、非法 UTF-8 或计算过于复杂时说明原因并提供原生 diff。Git blob/磁盘/CVS 读取均受边界和大小限制；原生 CVS 快照沿用 16 MiB CLI 上限。现有编辑及三路合并仍通过原有入口，不在内嵌预览内保存、暂存代码块或解决冲突。

## 验收边界

自动测试使用临时 Git 仓、本地 bare remote 与临时 `:local:` CVS 仓，没有向真实远程推送内容。组件、模拟 Host 和实际 CLI 验证分别记录。未打开 VS Code 测试窗口；真实布局观感、焦点、拖拽、实际 Reload、关闭重开和安装切换仍需单独验收。发现和更新不解除既有子仓写入保护。既有依赖风险与本地文件系统竞态限制继续保留在 [安全记录](./security-review.md)。

## 改版设计

> 用户决定（2026-10-28）：交互参照 IntelliJ IDEA 的 Git，不以编辑器面板为主；Git 与 CVS 采用同一套交互，由 JetTortoise 接管 Git 的「源代码管理」视图。S1 上线时本节并入正文并重写 `CLAUDE.md` 的 Contracts 段。

### 0.5.1 实测基线（2026-10-28）

- 0.5.1 已装到 141 远程端、141 本机 VS Code 与 M3；已打开的窗口要重载后才会加载。
- 141 NsnWeb（3088 个文件）：清单耗时 18.7 秒，`cvs -n -q update` 整树状态 49 秒，一次完整刷新约 68 秒，超过下文失败标准里的 60 秒，S1 要先把首屏刷新压下来（例如先出清单再异步补状态，保存时只刷单文件）。
- 现有映射把远端有更新的文件（`Needs Checkout`/`Needs Patch`）也显示为“修改”，S1 的资源组要把它们与本地修改分开。
- 0.5.0 在 141 上出现过「无法完整确认仓库边界」（`BOUNDARY_UNAVAILABLE`），来源至今未复现，候选见执行记录；S1 在真实窗口验收时留意。
- 打开方式与远端落点见总仓 `wiki/gtd/reference/technical/machine-matrix.md`「141 Windows 的 VS Code」。

### 真实需求

日常提交路径要和 IDEA 一样短：

1. 改完文件，改动自动出现在侧栏列表里。
2. 单击文件，在编辑器里看 diff。
3. 写提交说明，提交。

历史、分支、更新、推送放在固定位置，不打断编辑。现状的问题：所有操作都要先打开一个四栏编辑器标签页，靠手动刷新；仓库列表常驻并占位；在 141 NsnWeb 上列表里有十几个仓库，其中多数是误识别的。

### IDEA 与 VS Code 的对应

| IDEA | JetTortoise 新形态 | VS Code 落点 |
| --- | --- | --- |
| Commit 工具窗口（变更列表、提交说明、Commit / Commit and Push） | 每个仓库一个 SourceControl：资源组按 IDEA changelist 分为「更改」「暂不提交」「未纳入版本控制」「冲突」；`inputBox` 写提交说明；接受按钮提交「更改」组 | `vscode.scm.createSourceControl` |
| 双击文件看 diff | 单击资源打开 `vscode.diff`（基线 ↔ 工作区） | resource `command` |
| 编辑器行号旁的改动标记 | `quickDiffProvider` 返回基线 URI（Git 为 HEAD，CVS 为 Entries 修订），沿用现有内容提供者 | SourceControl.quickDiffProvider |
| 资源管理器里文件变色 | 资源 decorations（颜色、删除线、提示） | SourceControlResourceDecorations |
| 本地改动自动刷新 | 每个已登记仓根一个 FileSystemWatcher：保存时只刷新单个文件（Git 用 `status --porcelain -- <path>`，CVS 用单文件 `status`）；每次操作后和窗口获得焦点时全量刷新；`scm/title` 保留手动刷新 | workspace.createFileSystemWatcher |
| Git 工具窗口的 Log 页（分支栏、提交图、详情、变更文件） | 底部面板容器「JetTortoise」里的 Log 视图，复用 `packages/vcs-ui` 的历史、图与详情组件；Git 和 CVS 共用一个视图 | `viewsContainers.panel` + `WebviewViewProvider` |
| 右键 Git ▸ Show History / Compare with Revision / Rollback / Annotate | 编辑器、资源管理器、SCM 资源的右键菜单「JetTortoise ▸ 显示历史／与修订比较／回滚／更新」；文件历史在 Log 视图里按路径过滤打开 | `menus`：`editor/context`、`explorer/context`、`scm/resourceState/context` |
| Update Project、Push 对话框、冲突对话框 | 「更新」放在 `scm/title`；推送、冲突、回滚确认仍按需打开现有的对话式页面（`pushPanel`、`conflictsManager`、`rollbackPanel`），这和 IDEA 弹对话框一致 | 现有 views |
| 状态栏分支挂件 | 当前仓库的分支或 Tag 显示在状态栏；点击弹 QuickPick（Git：切换、新建分支；CVS：只显示 Tag） | StatusBarItem + QuickPick |
| 多仓 | 原生 SCM 多仓列表，一个仓库一个 SourceControl；不再常驻 JetTortoise 自己的仓库列表 | 原生 |

### 已定默认（实现照此，不再询问）

- **部分提交**：VS Code SCM 没有逐文件勾选，用资源组表达 IDEA changelist。提交 = 「更改」组的全部文件；不想提交的拖进或通过右键移到「暂不提交」。
  - Git 用 `git commit -- <paths>`：提交这些路径的工作区内容，忽略已有的部分暂存，这正是 IDEA 的语义。
  - CVS 用 `cvs commit <files>`，不变。
  - 「暂不提交」的成员保存在 workspaceState。
- **与内置 Git 共存**：不静默关闭 `git.enabled`，因为 GitHub PR、Copilot 生成提交说明等扩展依赖内置 Git 的 API。
  - 每个工作区首次接管某个 Git 仓库时，在流程里提示一次：「在本工作区忽略内置 Git 对该仓库的管理」，确认后写入工作区设置 `git.ignoredRepositories`。拒绝则两者并存，文档写明。
  - 实现前在 VS Code 1.143 核实两点：被忽略的仓库是否也从 Git API 中消失（会影响上述扩展）；内置 Git 与本扩展两个 quickDiffProvider 同时存在时，行号标记是否会重复。核实结论写进 RECORD。
- **旧编辑器标签页**：保留 `jettortoise.workspace` 的 `WebviewPanelSerializer`。重载窗口时恢复出来的旧标签页直接关闭，并聚焦 SCM 视图，避免出现报错页。`docs/migration.md` 写明这一点。
- **保持不变**：
  - 仓库登记（自动发现、手动添加、隐藏）、子仓边界保护、每仓串行队列、破坏性操作二次确认、Webview 不能指定 cwd、中英两种语言；
  - 0.5.1 的 CVS 整树状态（`-n -q update`）与规模上限；
  - IDEA Shelf、stash、cherry-pick 等已有 Git 能力，改从 SCM 右键菜单或 Log 视图进入。
- **不做**：不新增设置项；不做 Git 的逐行或逐块暂存（保持 IDEA 默认的整文件语义）；不做 Annotate（另立项）；不改 Marketplace 发布流程。

### 删掉什么

- 四栏编辑器工作台：仓库列表、提交、只读 diff、历史四栏，以及 `jettortoise.openHistory`、`jettortoise.openCommit` 打开的主标签页。
- 左上常驻的仓库列表组件（`RepositoryList.tsx`、`RepositoryBoundaries.tsx` 在面板中的用法）；仓库切换改由原生 SCM 多仓列表和状态栏完成。
- `webview/src/commit`、`webview/src/cvs` 中仅为工作台存在的提交界面。
- 与工作台布局绑定的 layout-state 与 workbench channel 检查。随功能删除，不留死代码。

### 切片（顺序执行，各自一份任务书）

1. **S1：两种仓库的 SCM 提供者**
   - 内容：资源组、单击看 diff、quickDiff、decorations、提交、右键回滚／加入版本控制／忽略、自动刷新、内置 Git 提示。
   - 同时把 `src/repositories/discovery.ts` 中重复的 `isCvsContinuation` 并入 `boundaries.cjs`。
   - 旧工作台暂时保留可用。
2. **S2：底部 Log 视图**
   - 内容：Log 视图、文件历史、「更新」「推送」入口、状态栏分支 QuickPick。
   - 从旧工作台删除提交栏和 diff 栏。
3. **S3：删除旧工作台与收尾**
   - 删除工作台和常驻仓库列表，加上旧标签页的 serializer 兜底。
   - 重写 `CLAUDE.md` 的 Contracts 段及相关 docs。
   - 版本 0.6.0，补 `CHANGELOG`。

每片的验证：
- `pnpm run check:l10n`、`build`、`test:headless`、`vsce:package`。
- `test:headless` 的 vscode mock 按需补齐 SCM API，不许绕开。

额度按 `quota --task long`。每片用 xhigh，理由：跨模块、新的 API 面。

### 验收（每片在真实窗口里做，不只靠 headless）

- **CVS**：M3 经 Remote-SSH 打开 141 的 `D:\IT\workspace\nsn\NsnWeb`。
  - NSNET-4223 的 4 个 vslch 文件出现在「更改」组，单击能打开 diff，行号旁有改动标记。
  - `rebel.xml` 出现在「未纳入版本控制」或「更改」中，与 `-n -q update` 的结果一致。
  - 仓库列表不再出现 ctmvm、odmrg 这类误识别的仓库。
- **Git**：M3 本地窗口打开插件仓本身，改一个文件后立即出现在列表中；把文件移到「暂不提交」后，提交不会带上它。
- **预计**：S1 约 1 天执行加半天验收；S2、S3 各约半天到 1 天。
- **怎样算失败**：
  - 任一片结束时，日常提交路径仍需要打开编辑器标签页；
  - 或 141 NsnWeb 刷新超过 60 秒；
  - 或内置 Git 与 JetTortoise 在同一仓库上产生重复的行号标记，而且没有可选的解决方式。
