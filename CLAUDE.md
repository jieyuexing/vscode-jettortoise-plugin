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

Changes 的计数只含已管理的本地变更。Unversioned Files 和 Incoming 默认折叠、不计数、不预选。未管理目录只展示节点，展开才读取其下一层；先通过 Add to Version Control 纳管，随后在 Changes 勾选提交。Incoming 只读，不能提交，不显示复选框，以向下箭头标记远端新版本。Changes 的根文件直接列出，只有子目录创建目录组；分组内只显示文件名，关闭目录分组才显示路径。仅 Changes、Unversioned Files 和 Incoming 标题转大写，目录保留原名，计数使用单复数 file/files，展开箭头复用上游 chevron。Git 的分阶段行合并为一个路径选择，提交取所选文件的磁盘内容；重命名带旧、新两条路径。

Git 与 CVS 每仓一次提交、各自排队，不把多个仓库承诺为一个原子事务。开始前验证全部所选根；逐仓失败会报告已经成功的仓库并保留说明。Git 先检查完整索引，再 `git commit -m <message> -- <paths>`，未选择的暂存内容保留。Amend 和 Commit and Push 只在单个 Git 仓选择中可用；Shelf/Stash 明示仅 Git。

一个 `kind + canonical root` 对应独立的服务、队列、watcher、快照、错误和修订内容访问权。当前编辑器只驱动底部 Log 的默认仓库；提交区明确选择的仓库优先控制 Update Project。Git 日志行在说明前显示分支/标签标记，说明保留完整文本并由行内布局在末尾省略，不修改原图或其它日志组件。CVS 文件历史只列所选文件的修订号、日期、作者和说明；点修订用原生 diff 比较上一修订。工作区 diff 为 Entries 的 BASE 与磁盘。

CVS 首次、手动和写后刷新先发布 Entries/Entries.Log 本地段，再在后台跑一次 `cvs -f -n -q update`。焦点只读本地；保存只读该文件，保留最近确认的远端状态。网络结果为权威状态；网络开始前记录文件 mtime，只有其后 mtime 变化的文件才用本地结果覆盖。网络已确认干净的文件在 mtime 和修订号未变时继续保持干净，避免焦点刷新恢复假修改。网络失败保留本地快照并只在该仓显示错误。Git 沿用上游 watcher，每根独立；保存按真实物理归属判断。

**真实边界决定写权限，发现与展示不能解除边界。** 同项目但父 Entries 未登记的 CVS 目录不单列，也不进入父仓任何组，仍阻止父仓整树写。连续 CVS 目录合并读取 Entries.Log。发现不越出工作区，不跟随目录软链，不调用 VCS CLI。最近真实边界即使未登记也保护文件，不回落祖先；子目录窗口不借用窗口外根。

文件修改重新检查归属和符号链接；Git 提交验证完整索引，包括已被父仓跟踪的子仓重叠。checkout/reset、merge/rebase、全量 stash、patch 及 CVS 整树 update 沿用完整树预检，无法证明安全就拒绝。清单读取可在未管理目录停止，整树写预检不能使用这一优化。写操作在队列执行与确认后重新验证工作区可用性和信任；未保存编辑器阻止覆盖或提交。

Update Project 只更新当前分支 upstream，Git 固定 `pull --ff-only --no-rebase --no-autostash --no-recurse-submodules`，分叉不自动合并、变基或 stash。CVS 复用整树更新和子仓预检；通知区进度可取消。取消不承诺已经应用的文件写入自动回滚。

不移植 catalog、四栏编辑器工作台、`packages/vcs-ui`、原生 SCM provider 或 `git.ignoredRepositories`。界面本轮用英文，不读旧扩展存储，不注册旧命令前缀。依赖沿用 lockfile，不升级。

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
