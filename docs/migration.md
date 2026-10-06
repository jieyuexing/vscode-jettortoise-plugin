# JetTortoise 迁移说明

本次迁移保留主仓 Git 历史与未提交修改，使用全新的 VS Code 扩展身份。目录已改为 `vscode-jettortoise-plugin`，版本仍为 `0.4.17`。旧 JetGit 和 JetCVS 的私有存储、已打开虚拟文档、草稿及布局不会自动迁入。

| 项目 | 新值 |
| --- | --- |
| 显示名称 | JetTortoise |
| 技术名 / publisher | `jettortoise` / `jetgit` |
| 扩展 ID | `jetgit.jettortoise` |
| 历史页面类型 / URI scheme | `jettortoise.workspace` / `jettortoise` |
| VSIX | `release/jettortoise-0.4.17.vsix` |
| 当前本地目录 | `/Users/jieyuexing/dsh-universe/dsh-workspaces/projects/vscode-plugins/vscode-jettortoise-plugin` |

## GitHub 状态

**GitHub 改名已由用户完成，2026-09-15 核验通过。** 新公开仓库为 `jieyuexing/vscode-jettortoise-plugin`，仓库 ID 仍为 `1366444411`，与改名前一致。本机 `origin` 的 fetch/push 地址均已更新为：

```text
git@github.com:jieyuexing/vscode-jettortoise-plugin.git
```

manifest 与 README 已使用新地址。连接器已确认新仓名和原仓库身份；SSH 只读访问结果记入 [验收记录](./jettortoise-validation.md)。本次仅更新本地 remote 和记录，没有创建替代仓库、拉取、提交、推送或发布。

## 命令与快捷键

新扩展不注册旧命令别名。用户自定义快捷键中的 command 应改为下表的新值。

| 旧入口 | 新入口 |
| --- | --- |
| `git-brains.openLog`、`git-brains.gitLog.focus`、`git-brains.showFileHistory`、`jetcvs.openHistory` | `jettortoise.openHistory` |
| `git-brains.openCommit`、`git-brains.commitPanel.focus`、`jetcvs.openCommit`、`jetcvs.commit.focus` | `jettortoise.openCommit` |
| `git-brains.refreshLog`、`jetcvs.refresh` | `jettortoise.refresh` |
| `git-brains.openPushPanel` | `jettortoise.git.openPushPanel` |
| `git-brains.openConflicts` | `jettortoise.git.openConflicts` |
| `git-brains.openMergeEditorFromSCM` | `jettortoise.git.openMergeEditorFromSCM` |
| `git-brains.nextDiff` / `git-brains.prevDiff` / `git-brains.editSource` | `jettortoise.git.nextDiff` / `jettortoise.git.prevDiff` / `jettortoise.git.editSource` |
| `jetcvs.checkout` / `jetcvs.update` / `jetcvs.cancel` | `jettortoise.cvs.checkout` / `jettortoise.cvs.update` / `jettortoise.cvs.cancel` |

原有推送 `Ctrl+Shift+K`（macOS `Cmd+Shift+K`）和 diff 导航 `Ctrl+F7` / `Ctrl+Shift+F7`（macOS 使用 `Cmd`）保留按键组合，但限定在活动 Git 页面或 diff 上下文。旧清单中没有实现的五个 Commit 命令不继续声明；提交、Shelf/Stash 使用工作面板内的对应按钮。

将用户级 `jetcvs.cvsPath` 的客户端路径手动填入 `jettortoise.cvsPath`。该设置仍为 machine scope，不读取工作区提供的可执行文件配置，不自动下载安装 CVS。旧 URI 不继续解析，安装新扩展后请重新从历史页面打开 diff。

## 本地迁移与回退

迁移前、后对 **35,283 个文件系统条目**逐项比较类型、权限、符号链接目标、文件大小与 SHA-256，差异为 0；其中包含 `.git`、依赖目录、ignored 文件与旧 VSIX。完整清单在 [directory-migration.json.gz](./evidence/directory-migration.json.gz)，结果见 [jettortoise-evidence.json](./jettortoise-evidence.json)。后续构建产物与验收文档不属于该原子目录改名前后比较区间。

基线 commit 保持 `32f7f5e4659f948cfbe2bf19412bfec0147c7f07`。开始与结束均无暂存内容；未提交修改保留为工作区改动。部分 Git 状态读取更新了 index 的 stat cache，故整轮 index 文件字节摘要不是不变量；目录改名前后 index 字节则逐项一致。没有执行 add、commit、push 或 reset。

原 JetCVS 源仓 `/Users/jieyuexing/dsh-universe/dsh-workspaces/projects/vscode-plugins/vscode-jetcvs-plugin` 保留；本轮起点记录的 67 项文件摘要全部未变。跨仓 UI 同步脚本已退役，两个内核直接消费本仓公共 UI，不再需要 vendor 快照。

旧 `release/jetgit-0.4.17.vsix` 随主仓移至新目录并保留，JetCVS 的旧 VSIX 仍在原源仓。未自动卸载旧扩展或安装新包；如需回退，可手动禁用 JetTortoise 并继续使用旧包。请先保存旧页面草稿，再切换扩展；不要同时从两套插件对同一仓库执行写操作。


## 2026-09-15 嵌套仓库阶段复核

当前登记使用工作区 v2 格式，保留原显式登记并增加自动发现、来源及隐藏项；更早仅保存的候选列表仍不自动获得操作权限，详见[嵌套说明](./nested-repositories.md)。命令、根目录和扩展身份没有再次迁移。

当前 release 目录未找到上文迁移时记录的 `jetgit-0.4.17.vsix`；本轮没有删除此包，历史存在记录不能替代当前回退文件。当前可核实保留的是开始嵌套改动前复制的 `release/archive/jettortoise-before-nesting-20260915.vsix`，以及原 JetCVS 源仓和其安装包。摘要和当前产物见[验收记录](./jettortoise-validation.md)。
