# JetGit 文案清单

覆盖清单、Host，以及 Git Log、Commit/Shelf、Push、Rollback、Conflicts、三路合并与右键菜单。实施前按这些入口扫描，下面记录最终词典以便后续核对。

语言来自 VS Code：zh、zh-cn、zh-tw 使用简体；其它语言英文。Host 采用官方英文 source message 键，清单与 webview 使用语义 key。Git 输出、分支/文件名称、持久化默认 Shelf 名称与控制台诊断不作为 UI 翻译键。

运行 `pnpm run check:l10n` 检查 key、占位符、别名资源及 JSX/属性残留；语法扫描不代替动态提示与实际面板验收。

## Manifest（19 项）

| Key / source | English | 简体中文 |
| --- | --- | --- |
| category.jettortoise | JetTortoise | JetTortoise |
| cmd.commitPanel.commit | Commit | 提交 |
| cmd.commitPanel.commitAndPush | Commit and Push | 提交并推送 |
| cmd.commitPanel.refresh | Refresh Changes | 刷新变更 |
| cmd.commitPanel.shelve | Shelve Changes | 搁置变更 |
| cmd.commitPanel.unshelve | Unshelve Changes | 恢复搁置变更 |
| cmd.editSource | (JetGit) Edit Source | (JetGit) 编辑源文件 |
| cmd.nextDiff | Next File Diff | 下一个文件差异 |
| cmd.openConflicts | Conflicts | 冲突 |
| cmd.openMergeEditor | Open Merge Editor | 打开合并编辑器 |
| cmd.openMergeEditorFromSCM | Open in JetGit Merge Editor | 在 JetGit 合并编辑器中打开 |
| cmd.openPushPanel | Push... | 推送… |
| cmd.prevDiff | Previous File Diff | 上一个文件差异 |
| cmd.refreshLog | Refresh Git Log | 刷新 Git 日志 |
| cmd.showFileHistory | (JetGit) Show File History | (JetGit) 查看文件历史 |
| container.commit | Commit | 提交 |
| container.log | JetGit | JetGit |
| view.commitPanel | Commit | 提交 |
| view.gitLog | Git Log | Git 日志 |

## Extension Host（58 项）

| Key / source | English | 简体中文 |
| --- | --- | --- |
| All files | All files | 所有文件 |
| Cannot drop the initial commit (no parent) | Cannot drop the initial commit (no parent) | 无法丢弃初始提交（没有父提交） |
| Clipboard content does not appear to be a valid patch. | Clipboard content does not appear to be a valid patch. | 剪贴板内容似乎不是有效的补丁。 |
| Clipboard is empty or does not contain patch content. | Clipboard is empty or does not contain patch content. | 剪贴板为空或不包含补丁内容。 |
| Clipboard patch {0} | Clipboard patch {0} | 剪贴板补丁 {0} |
| Commit was removed from history but its changes could not be applied to the working directory | Commit was removed from history but its changes could not be applied to the working directory | 提交已从历史记录中移除，但其更改无法应用到工作目录 |
| Conflicts | Conflicts | 冲突 |
| Could not show diff for "{0}": {1} | Could not show diff for "{0}": {1} | 无法显示“{0}”的差异：{1} |
| Delete | Delete | 删除 |
| Delete "{0}"? This cannot be undone. | Delete "{0}"? This cannot be undone. | 要删除“{0}”吗？此操作无法撤销。 |
| Delete branch "{0}"? | Delete branch "{0}"? | 要删除分支“{0}”吗？ |
| Delete shelf "{0}"? This cannot be undone. | Delete shelf "{0}"? This cannot be undone. | 要删除搁置“{0}”吗？此操作无法撤销。 |
| Delete shelved changes "{0}"? This cannot be undone. | Delete shelved changes "{0}"? This cannot be undone. | 要删除搁置的更改“{0}”吗？此操作无法撤销。 |
| Delete {0} files? This cannot be undone. | Delete {0} files? This cannot be undone. | 要删除 {0} 个文件吗？此操作无法撤销。 |
| Discard | Discard | 放弃 |
| Failed to apply shelf "{0}": {1} | Failed to apply shelf "{0}": {1} | 应用搁置“{0}”失败：{1} |
| Failed to copy patch: {0} | Failed to copy patch: {0} | 复制补丁失败：{0} |
| Failed to create patch: {0} | Failed to create patch: {0} | 创建补丁失败：{0} |
| Failed to import patch from clipboard: {0} | Failed to import patch from clipboard: {0} | 从剪贴板导入补丁失败：{0} |
| Failed to import patches: {0} | Failed to import patches: {0} | 导入补丁失败：{0} |
| Failed to unshelve file: {0} | Failed to unshelve file: {0} | 取消搁置文件失败：{0} |
| File {0}/{1}: {2}  —  Press again to go to the next file | File {0}/{1}: {2}  —  Press again to go to the next file | 文件 {0}/{1}：{2}  —  再次按下可转到下一个文件 |
| Import Patch Files | Import Patch Files | 导入补丁文件 |
| Imported patch from clipboard as shelf entry. | Imported patch from clipboard as shelf entry. | 已将剪贴板补丁作为搁置条目导入。 |
| Imported {0} patch(es) | Imported {0} patch(es) | 已导入 {0} 个补丁 |
| Invalid commit hash | Invalid commit hash | 无效的提交哈希 |
| JetGit: No diff file list. Double-click a file in Changed Files first. | JetGit: No diff file list. Double-click a file in Changed Files first. | JetGit：没有差异文件列表。请先在“已更改文件”中双击一个文件。 |
| JetGit: No workspace open. | JetGit: No workspace open. | JetGit：未打开工作区。 |
| Merge commits cannot be dropped | Merge commits cannot be dropped | 无法丢弃合并提交 |
| Merge: {0} | Merge: {0} | 合并：{0} |
| No changes to shelve | No changes to shelve | 没有可搁置的更改 |
| No current branch | No current branch | 没有当前分支 |
| No file list available. Open a diff from Changed Files first. | No file list available. Open a diff from Changed Files first. | 没有可用的文件列表。请先从“已更改文件”打开差异比较。 |
| OK | OK | 确定 |
| Open JetGit Panel | Open JetGit Panel | 打开 JetGit 面板 |
| Operation timed out | Operation timed out | 操作超时 |
| Patch copied to clipboard | Patch copied to clipboard | 补丁已复制到剪贴板 |
| Patch files | Patch files | 补丁文件 |
| Patch saved to {0} | Patch saved to {0} | 补丁已保存到 {0} |
| Push Commits to {0} | Push Commits to {0} | 推送提交到 {0} |
| Read-only git content | Read-only git content | 只读 Git 内容 |
| Rollback | Rollback | 回滚 |
| Rollback Changes | Rollback Changes | 回滚更改 |
| Rollback changes to "{0}"? This cannot be undone. | Rollback changes to "{0}"? This cannot be undone. | 要回滚“{0}”的更改吗？此操作无法撤销。 |
| Rollback changes to {0} file(s)? This cannot be undone. | Rollback changes to {0} file(s)? This cannot be undone. | 要回滚 {0} 个文件的更改吗？此操作无法撤销。 |
| Save Patch File | Save Patch File | 保存补丁文件 |
| Show My Branches: filter applied in branch tree | Show My Branches: filter applied in branch tree | 显示我的分支：已在分支树中应用筛选 |
| Source file does not exist in the working directory. | Source file does not exist in the working directory. | 源文件在工作目录中不存在。 |
| Toggled favorite: {0} | Toggled favorite: {0} | 已切换收藏状态：{0} |
| Unable to locate conflict file from SCM item. | Unable to locate conflict file from SCM item. | 无法从 SCM 项中定位冲突文件。 |
| Unknown command: {0} | Unknown command: {0} | 未知命令：{0} |
| You have unsaved merge changes. Discard them? | You have unsaved merge changes. Discard them? | 你有未保存的合并更改。要放弃吗？ |
| {0} (HEAD ↔ Staged) | {0} (HEAD ↔ Staged) | {0}（HEAD ↔ 已暂存） |
| {0} (HEAD ↔ Working Tree) | {0} (HEAD ↔ Working Tree) | {0}（HEAD ↔ 工作区） |
| {0} (Shelved in {1}) | {0} (Shelved in {1}) | {0}（搁置于 {1}） |
| {0} (Shelved: {1}) | {0} (Shelved: {1}) | {0}（已搁置：{1}） |
| {0} ({1} commits) | {0} ({1} commits) | {0}（{1} 个提交） |
| {0} ↔ {1} | {0} ↔ {1} | {0} ↔ {1} |

## Webview（240 项）

| Key / source | English | 简体中文 |
| --- | --- | --- |
| commit.abortCherryPick | Abort Cherry-pick (git cherry-pick --abort) | 中止拣选 (git cherry-pick --abort) |
| commit.abortMerge | Abort Merge (git merge --abort) | 中止合并 (git merge --abort) |
| commit.abortRebase | Abort Rebase (git rebase --abort) | 中止变基 (git rebase --abort) |
| commit.addToVcs | Add to VCS | 添加到版本控制 |
| commit.amend | Amend | 修订 |
| commit.changes | Changes | 变更 |
| commit.cherryPicking | Cherry-picking | 正在拣选 |
| commit.cherryPickingCommit | Cherry-picking {hash} | 正在拣选 {hash} |
| commit.collapseAll | Collapse All | 全部折叠 |
| commit.commit | Commit | 提交 |
| commit.commitAndPush | Commit and Push | 提交并推送 |
| commit.commitAndPushMenu | Commit and Push... | 提交并推送... |
| commit.commitMessage | Commit message (Ctrl+Enter to commit) | 提交消息（Ctrl+Enter 提交） |
| commit.continueCherryPick | Continue Cherry-pick (git cherry-pick --continue) | 继续拣选 (git cherry-pick --continue) |
| commit.continueRebase | Continue Rebase (git rebase --continue) | 继续变基 (git rebase --continue) |
| commit.copyPatch | Copy as Patch to Clipboard | 复制为补丁到剪贴板 |
| commit.createPatch | Create Patch... | 创建补丁... |
| commit.delete | Delete... | 删除... |
| commit.deleteDirectory | Delete "{directory}"... | 删除“{directory}”... |
| commit.directory | Directory | 目录 |
| commit.expandAll | Expand All | 全部展开 |
| commit.groupBy | Group By | 分组方式 |
| commit.ideaShelfHelp | Use the shelf icon in the Commit tab toolbar to shelve changes to .idea/shelf/ (IDEA-compatible format). | 使用 Commit 面板工具栏中的搁置图标，将更改搁置到 .idea/shelf/（兼容 IDEA 格式）。 |
| commit.importPatches | Import Patches... | 导入补丁... |
| commit.importPatchesClipboard | Import Patches from Clipboard | 从剪贴板导入补丁 |
| commit.jumpToSource | Jump to Source | 跳转到源文件 |
| commit.mergeConflicts | Merge Conflicts | 合并冲突 |
| commit.merging | Merging | 正在合并 |
| commit.mergingBranch | Merging {branch} | 正在合并 {branch} |
| commit.noChanges | No changes detected | 未检测到更改 |
| commit.noRecentMessages | No recent commit messages | 没有最近的提交消息 |
| commit.noShelvedChanges | No shelved changes | 没有搁置的更改 |
| commit.openInSystemFolder | Open in System Folder | 在系统文件夹中打开 |
| commit.pull | Pull | 拉取 |
| commit.pushAction | Push... | 推送… |
| commit.rebasing | Rebasing | 正在变基 |
| commit.rebasingBranch | Rebasing {branch} | 正在变基 {branch} |
| commit.recentMessages | Recent commit messages | 最近的提交消息 |
| commit.refresh | Refresh | 刷新 |
| commit.resolve | Resolve | 解决 |
| commit.resolveConflicts | Resolve Conflicts | 解决冲突 |
| commit.restore | Restore | 恢复 |
| commit.rollback | Rollback... | 回滚... |
| commit.rollbackTooltip | Rollback | 回滚 |
| commit.shelfHelp | Use the shelf icon in the Commit tab toolbar to shelve changes. | 使用 Commit 面板工具栏中的搁置图标来搁置更改。 |
| commit.shelfLaterHelp | Use the shelf icon in the Commit tab toolbar to shelve changes for later. | 使用 Commit 面板工具栏中的搁置图标，稍后再恢复这些更改。 |
| commit.shelveChanges | Shelve Changes... | 搁置更改... |
| commit.shelveChangesTooltip | Shelve Changes | 搁置变更 |
| commit.show | Show | 显示 |
| commit.showDiff | Show Diff | 显示差异 |
| commit.skipCherryPick | Skip Cherry-pick (git cherry-pick --skip) | 跳过拣选 (git cherry-pick --skip) |
| commit.staged | Staged | 已暂存 |
| commit.tabCommit | Commit | 提交 |
| commit.tabShelf | Shelf | 搁置 |
| commit.tabStash | Stash | 贮藏 |
| commit.unshelve | Unshelve... | 取消搁置... |
| commit.unstage | Unstage | 取消暂存 |
| commit.unversionedFiles | Unversioned Files | 未版本控制的文件 |
| commit.viewOptions | View Options | 视图选项 |
| common.authoredOn | on {date} | 于 {date} |
| common.cancel | Cancel | 取消 |
| common.fileCount | {count} file{plural} | {count} 个文件 |
| common.flatList | Flat List | 平铺列表 |
| common.loading | Loading... | 正在加载... |
| common.requestTimedOut | Request '{command}' timed out | 请求“{command}”超时 |
| common.treeView | Tree View | 树形视图 |
| common.unknownError | Unknown error | 未知错误 |
| conflicts.acceptTheirs | Accept Theirs | 接受对方版本 |
| conflicts.acceptYours | Accept Yours | 接受你的版本 |
| conflicts.allResolved | All conflicts resolved | 所有冲突均已解决 |
| conflicts.groupByDirectory | Group files by directory | 按目录分组文件 |
| conflicts.inProgress | Merge in progress | 合并进行中 |
| conflicts.loading | Loading... | 正在加载... |
| conflicts.merge | Merge... | 合并... |
| conflicts.merging | Merging branch {from} into {into} | 正在将分支 {from} 合并到 {into} |
| conflicts.modified | Modified | 已修改 |
| conflicts.name | Name | 名称 |
| conflicts.noneInProgress | No merge in progress | 没有进行中的合并 |
| conflicts.theirs | Theirs | 对方版本 |
| conflicts.title | Conflicts | 冲突 |
| conflicts.withConflicts | {count} file{plural} with conflicts | {count} 个文件存在冲突 |
| conflicts.yours | Yours | 你的版本 |
| merge.acceptAllLeft | Accept all changes from left side | 接受左侧所有变更 |
| merge.acceptAllRight | Accept all changes from right side | 接受右侧所有变更 |
| merge.acceptLeft | Accept Left | 接受左侧 |
| merge.acceptLeftChange | Accept left | 接受左侧 |
| merge.acceptRight | Accept Right | 接受右侧 |
| merge.acceptRightChange | Accept right | 接受右侧 |
| merge.apply | Apply | 应用 |
| merge.applyError | Apply failed: {message} | 应用失败：{message} |
| merge.cancel | Cancel | 取消 |
| merge.centerResult | Center (Result) | 中间（结果） |
| merge.discardAndClose | Discard changes and close | 放弃变更并关闭 |
| merge.leftTheirs | Left (Theirs) | 左侧（对方版本） |
| merge.loadError | Failed to load merge content. | 无法加载合并内容。 |
| merge.loadingEditor | Loading merge editor... | 正在加载合并编辑器… |
| merge.missingPath | Missing merge file path. | 缺少合并文件路径。 |
| merge.nextConflict | Next Conflict | 下一个冲突 |
| merge.previousConflict | Previous Conflict | 上一个冲突 |
| merge.rightYours | Right (Yours) | 右侧（你的版本） |
| merge.saveAndStage | Save merged result and stage file | 保存合并结果并暂存文件 |
| merge.skipLeft | Skip left | 跳过左侧 |
| merge.skipRight | Skip right | 跳过右侧 |
| merge.summary | {changes} changes · {conflicts} conflicts | {changes} 处变更 · {conflicts} 处冲突 |
| merge.undo | Undo | 撤销 |
| panel.allBranches | All branches | 所有分支 |
| panel.allTime | All time | 不限时间 |
| panel.allUsers | All users | 所有用户 |
| panel.apply | Apply | 应用 |
| panel.applyMessage | Apply changes to '{file}' from this commit to working tree? | 将此提交中对 '{file}' 的更改应用到工作区？ |
| panel.author | Author | 作者 |
| panel.branchExistsMessage | Branch '{branch}' already exists.<br>Change the name or overwrite existing branch. | 分支“{branch}”已存在。<br>请更改名称或覆盖现有分支。 |
| panel.branchFilter | Branch | 分支 |
| panel.branchName | branch-name | 分支名称 |
| panel.branchNameLabel | Branch Name: | 分支名称： |
| panel.branchNamePlaceholder | branch-name | 分支名称 |
| panel.branchOrTag | Branch or tag | 分支或标签 |
| panel.changedFiles | Changed Files | 变更文件 |
| panel.checkout | Checkout | 检出 |
| panel.checkoutAndRebase | Checkout and Rebase onto '{branch}' | 检出并变基到 '{branch}' |
| panel.checkoutBranchOption | Checkout branch | 检出分支 |
| panel.checkoutRevision | Checkout Revision | 检出修订版本 |
| panel.cherryPick | Cherry-Pick | 拣选 |
| panel.cherryPickSelected | Cherry-Pick Selected Changes | 拣选选中的更改 |
| panel.collapseAll | Collapse All | 全部折叠 |
| panel.columns | Columns | 列 |
| panel.compareWithCurrent | Compare with Current | 与当前分支比较 |
| panel.copyFileName | Copy File Name | 复制文件名 |
| panel.copyPath | Copy Path | 复制路径 |
| panel.copyRevision | Copy Revision Number | 复制修订号 |
| panel.copyRevisionNumber | Copy Revision Number | 复制提交哈希 |
| panel.createBranch | Create Branch from {startPoint} | 从 {startPoint} 创建分支 |
| panel.createBranchButton | Create | 创建 |
| panel.createBranchFrom | Create Branch from {ref} | 从 {ref} 创建分支 |
| panel.currentBranch | Current Branch: {branch} | 当前分支：{branch} |
| panel.date | Date | 日期 |
| panel.dateFilter | Date | 日期 |
| panel.delete | Delete | 删除 |
| panel.deleteBranch | Delete Branch | 删除分支 |
| panel.deleteBranchMessage | Delete branch '{branch}'? | 删除分支 '{branch}'？ |
| panel.detached | detached | 分离状态 |
| panel.dropCommit | Drop Commit | 丢弃提交 |
| panel.dropMessage | Drop commit {hash} "{subject}"?<br><br>This will remove the commit from history but keep its changes as unstaged modifications.<br><br>This operation cannot be undone. | 丢弃提交 {hash} "{subject}"？<br><br>这会从历史中移除该提交，但将其更改保留为未暂存修改。<br><br>此操作无法撤销。 |
| panel.editSource | Edit Source | 编辑源文件 |
| panel.expandAll | Expand All | 全部展开 |
| panel.fetch | Fetch | 获取 |
| panel.flattenList | Flatten List | 平铺列表 |
| panel.forceDelete | Force Delete | 强制删除 |
| panel.forceDeleteBranchMessage | Branch '{branch}' is not fully merged. Force delete? | 分支 '{branch}' 尚未完全合并。强制删除？ |
| panel.groupByDirectory | Group By Directory | 按目录分组 |
| panel.hash | Hash | 哈希 |
| panel.hideBranches | Hide Branches | 隐藏分支 |
| panel.hideDetails | Hide Details | 隐藏详情 |
| panel.history | History: | 历史： |
| panel.historyUpToHere | History Up to Here | 查看至此的历史 |
| panel.last30Days | Last 30 days | 最近 30 天 |
| panel.last7Days | Last 7 days | 最近 7 天 |
| panel.last90Days | Last 90 days | 最近 90 天 |
| panel.loading | Loading... | 正在加载… |
| panel.local | Local | 本地 |
| panel.merge | Merge | 合并 |
| panel.mergeBranchLabel | Merge '{branch}' into '{currentBranch}' | 将 '{branch}' 合并到 '{currentBranch}' |
| panel.mergeBranchMessage | Merge '{branch}' into '{currentBranch}'? | 将 '{branch}' 合并到 '{currentBranch}'？ |
| panel.message | Message | 消息 |
| panel.navigateLogToHead | Navigate Log to Branch Head | 将日志定位到分支头 |
| panel.navigateSelectedHead | Navigate Log to Selected Branch Head | 定位到所选分支的最新提交 |
| panel.newBranch | New Branch... | 新建分支... |
| panel.newBranchFrom | New Branch from '{branch}'... | 从 '{branch}' 新建分支... |
| panel.newBranchPrompt | Create new branch from {hash}: | 从 {hash} 创建新分支： |
| panel.newTag | New Tag... | 新建标签... |
| panel.newTagPrompt | Create tag at {hash}: | 在 {hash} 创建标签： |
| panel.noFileChanges | No changes to {file} in this commit | 本次提交未修改 {file} |
| panel.noMatches | No matches | 无匹配项 |
| panel.onSingleClick | On Single Click | 单击时 |
| panel.openRepositoryVersion | Open Repository Version | 打开仓库版本 |
| panel.overwriteBranchOption | Overwrite existing branch | 覆盖现有分支 |
| panel.push | Push... | 推送... |
| panel.pushBranchDescription | Push branch '{branch}' to remote '{remote}'. | 将分支“{branch}”推送到远程“{remote}”。 |
| panel.pushBranchTitle | Push Branch | 推送分支 |
| panel.rebase | Rebase | 变基 |
| panel.rebaseBranchLabel | Rebase '{currentBranch}' onto '{branch}' | 将 '{currentBranch}' 变基到 '{branch}' |
| panel.rebaseBranchMessage | Rebase '{currentBranch}' onto '{branch}'? | 将 '{currentBranch}' 变基到 '{branch}'？ |
| panel.remote | Remote | 远程 |
| panel.rename | Rename... | 重命名... |
| panel.renameBranchPrompt | Rename branch '{branch}' to: | 将分支 '{branch}' 重命名为： |
| panel.reset | Reset | 重置 |
| panel.resetHard | Reset Current Branch to Here (Hard)... | 将当前分支重置到此处（Hard）... |
| panel.resetMessage | Reset '{branch}' to {hash} (hard)? This will discard all uncommitted changes. | 将 '{branch}' 重置到 {hash}（hard）？这会丢弃所有未提交的更改。 |
| panel.resetMixed | Reset Current Branch to Here (Mixed)... | 将当前分支重置到此处（Mixed）... |
| panel.resetSoft | Reset Current Branch to Here (Soft)... | 将当前分支重置到此处（Soft）... |
| panel.revert | Revert | 还原 |
| panel.revertCommit | Revert Commit | 还原提交 |
| panel.revertMessage | Revert changes to '{file}' from this commit? | 还原此提交中对 '{file}' 的更改？ |
| panel.revertSelected | Revert Selected Changes | 还原选中的更改 |
| panel.searchCommits | Search commits... | 搜索提交... |
| panel.selectBranch | Select branch... | 选择分支... |
| panel.selectCommitDetails | Select a commit to view details | 选择提交以查看详情 |
| panel.selectCommitFiles | Select a commit to see changed files | 选择提交以查看变更文件 |
| panel.selectDateRange | Select date range... | 选择日期范围... |
| panel.selectUser | Select user... | 选择用户... |
| panel.settings | Settings | 设置 |
| panel.showBranches | Show Branches | 显示分支 |
| panel.showDetails | Show Details | 显示详情 |
| panel.showDiff | Show Diff | 显示差异 |
| panel.showInGitLog | Show in Git Log | 在 Git 日志中显示 |
| panel.showMyBranches | Show My Branches | 显示我的分支 |
| panel.showTags | ✓ Show Tags | ✓ 显示标签 |
| panel.tagNamePlaceholder | tag-name | 标签名称 |
| panel.tags | Tags | 标签 |
| panel.today | Today | 今天 |
| panel.toggleFavorite | Mark/Unmark As Favorite | 添加／取消收藏 |
| panel.update | Update | 更新 |
| panel.updateBranchFilter | Update Branch Filter | 更新分支筛选 |
| panel.updateSelected | Update Selected | 更新所选分支 |
| panel.userFilter | User | 用户 |
| panel.viewOptions | View Options | 视图选项 |
| push.branch | Branch | 分支 |
| push.branchName | branch name | 分支名称 |
| push.forcePush | Force Push | 强制推送 |
| push.merged | Merged and pushed to {target} | 已合并并推送到 {target} |
| push.noCommits | No commits to push | 没有可推送的提交 |
| push.noRemotes | No remotes found | 未找到远程仓库 |
| push.noSelection | No commits selected | 未选择提交 |
| push.push | Push | 推送 |
| push.pushed | Pushed {count} commit{plural} to {target} | 已推送 {count} 个提交到 {target} |
| push.pushing | Pushing... | 正在推送... |
| push.rebased | Rebased and pushed to {target} | 已变基并推送到 {target} |
| push.rejected | Push Rejected | 推送被拒绝 |
| push.rejectedMessage | Push of the current branch "{branch}" was rejected. Remote changes need to be merged before pushing. | 当前分支 "{branch}" 的推送被拒绝。请先合并远程更改再推送。 |
| push.remote | Remote | 远程 |
| push.upToDate | Everything is up to date | 已是最新状态 |
| rollback.deleteLocalCopies | Delete local copies of added files | 删除新增文件的本地副本 |
| rollback.rollback | Rollback | 回滚 |
| rollback.rollingBack | Rolling back... | 正在回滚... |
| shelf.changesLabel | Changes | 变更 |
| shelf.daysAgo | {count}d ago | {count} 天前 |
| shelf.hoursAgo | {count}h ago | {count} 小时前 |
| shelf.justNow | just now | 刚刚 |
| shelf.manyFiles | {count} files | {count} 个文件 |
| shelf.oneFile | {count} file | {count} 个文件 |
