// Run via VS Code --extensionTestsPath. Use isolated user-data and extensions dirs.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vscode = require('vscode');
exports.run = async function () {
  if (process.env.JETGIT_EXPECT_LANGUAGE) assert.equal(vscode.env.language, process.env.JETGIT_EXPECT_LANGUAGE);
  const extension = vscode.extensions.getExtension('jetgit.idea-like-git-graph');
  assert.ok(extension, 'JetGit extension missing');
  await extension.activate();
  const chinese = ['zh', 'zh-cn', 'zh-tw'].includes(vscode.env.language.toLowerCase());
  const commands = await vscode.commands.getCommands(true);
  const missingCommands = extension.packageJSON.contributes.commands.filter(item => !commands.includes(item.command)).map(item => item.command);
  // These five declarations are already unregistered in the upstream baseline.
  assert.deepEqual(missingCommands.sort(), ['git-brains.commitPanel.refresh', 'git-brains.commitPanel.commit', 'git-brains.commitPanel.commitAndPush', 'git-brains.commitPanel.shelve', 'git-brains.commitPanel.unshelve'].sort());
  assert.ok(commands.includes('git-brains.refreshLog'));
  assert.ok(commands.includes('git-brains.openMergeEditor'));
  assert.ok(commands.includes('git-brains.openPushPanel'));
  const title = extension.packageJSON.contributes.commands.find(c => c.command === 'git-brains.refreshLog').title;
  // VS Code can retain original command text in a localized-string object.
  const resolvedTitle = typeof title === 'string' ? title : title.value;
  assert.equal(resolvedTitle, chinese ? '刷新 Git 日志' : 'Refresh Git Log');
  const message = vscode.l10n.t('JetGit: No workspace open.');
  assert.equal(message, chinese ? 'JetGit：未打开工作区。' : 'JetGit: No workspace open.');
  await vscode.commands.executeCommand('git-brains.gitLog.focus');
  await vscode.commands.executeCommand('git-brains.commitPanel.focus');
  const result = {language: vscode.env.language, extension: extension.id, commandTitle: resolvedTitle, hostMessage: message, declaredCommands: extension.packageJSON.contributes.commands.length, baselineUnregisteredCommands: missingCommands};
  if (process.env.JETGIT_SMOKE_RESULT) fs.writeFileSync(process.env.JETGIT_SMOKE_RESULT, JSON.stringify(result, null, 2));
  console.log(JSON.stringify(result));
  if (process.env.JETGIT_SMOKE_HOLD_MS) {
    await vscode.commands.executeCommand('git-brains.openPushPanel');
    await vscode.commands.executeCommand('git-brains.openConflicts');
    await vscode.commands.executeCommand('git-brains.openMergeEditor', 'sample.txt');
    await vscode.commands.executeCommand('git-brains.openPushPanel');
    const until = Date.now() + Number(process.env.JETGIT_SMOKE_HOLD_MS);
    while (Date.now() < until) {
      const actionFile = process.env.JETGIT_SMOKE_ACTION_FILE;
      if (actionFile && fs.existsSync(actionFile)) {
        const action = fs.readFileSync(actionFile, 'utf8').trim();
        fs.unlinkSync(actionFile);
        const actions = {log: 'git-brains.gitLog.focus', commit: 'git-brains.commitPanel.focus'};
        if (actions[action]) await vscode.commands.executeCommand(actions[action]);
      }
      await new Promise(resolve => setTimeout(resolve, 100));
    }
  }
};
