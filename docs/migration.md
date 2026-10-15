# 从 JetGit / JetCVS 迁移

JetTortoise 是全新的 VS Code 扩展身份，不导入旧 JetGit、JetCVS 的私有存储、已打开的虚拟文档、提交草稿和布局。两套旧扩展可以与 JetTortoise 并存，但不要同时用两套插件对同一仓库执行写操作。

| 项目 | 值 |
| --- | --- |
| 显示名称 | JetTortoise |
| 扩展 ID | `jieyuexing.jettortoise` |
| 历史页面类型 / URI scheme | `jettortoise.workspace` / `jettortoise` |
| 仓库 | <https://github.com/jieyuexing/vscode-jettortoise-plugin> |

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

推送 `Ctrl+Shift+K`（macOS `Cmd+Shift+K`）和 diff 导航 `Ctrl+F7` / `Ctrl+Shift+F7`（macOS 使用 `Cmd`）保留按键组合，但限定在活动 Git 页面或 diff 上下文。旧清单中没有实现的五个 Commit 命令不再声明；提交、Shelf/Stash 使用工作面板内的对应按钮。

## 设置

将用户级 `jetcvs.cvsPath` 的客户端路径手动填入 `jettortoise.cvsPath`。该设置为 machine scope，不读取工作区提供的可执行文件配置，不自动下载安装 CVS。旧 URI 不再解析，安装新扩展后请重新从历史页面打开 diff。

## 仓库登记

登记保存在当前 VS Code 工作区的 `repositoryRegistrations` v2，包含自动/手动来源、隐藏项和发现状态；v1 登记直接迁移，仓库 ID 与页面状态不变。更早仅保存的候选列表只作为待确认项，不自动获得操作权限，详见[嵌套仓库说明](./nested-repositories.md)。

## 回退

卸载或禁用 JetTortoise，继续使用旧扩展即可；切换前先保存旧页面中的草稿。
