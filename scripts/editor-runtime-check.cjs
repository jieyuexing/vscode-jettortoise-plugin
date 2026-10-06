/*
 * Runs the history editor-tab lifecycle in an isolated VS Code window.
 *
 * Usage:
 *   node scripts/editor-runtime-check.cjs release/jetgit-0.4.17.vsix \
 *     docs/editor-runtime-evidence.json --run-gui
 *
 * The script creates a throw-away Git repository, user-data directory,
 * extensions directory and helper extension under the system temporary
 * directory. It never reads an existing workspace, remote, or credentials.
 */
const assert = require("node:assert/strict");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { spawn, spawnSync } = require("node:child_process");

const root = path.resolve(__dirname, "..");
const code = "/Applications/Visual Studio Code.app/Contents/Resources/app/bin/code";
const codeApp = "/Applications/Visual Studio Code.app/Contents/MacOS/Code";
const vsix = path.resolve(process.argv[2] || "release/jetgit-0.4.17.vsix");
const evidencePath = path.resolve(process.argv[3] || "docs/editor-runtime-evidence.json");
const timeoutMs = 90_000;
const vscodeCliEnv = { ...process.env };
// This check is normally launched from a VS Code extension-host terminal.
// Do not forward its IPC hook: doing so sends `code` back to that existing
// window and ignores the isolated user-data directory.
delete vscodeCliEnv.VSCODE_IPC_HOOK_CLI;
const installedExtensionsDir = path.join(os.homedir(), ".vscode", "extensions");
const activeChildren = new Set();
let stopping = false;

function run(command, args, options = {}) {
  const result = spawnSync(command, args, { encoding: "utf8", env: vscodeCliEnv, ...options });
  if (result.error) throw result.error;
  if (result.status !== 0) {
    throw new Error(`${command} ${args.join(" ")} failed (${result.status})\n${result.stdout}\n${result.stderr}`);
  }
  return result.stdout;
}

function waitForFile(file, child) {
  return new Promise((resolve, reject) => {
    const until = Date.now() + timeoutMs;
    const finish = error => {
      clearInterval(timer);
      child.removeListener("error", onError);
      if (error) reject(error); else resolve();
    };
    const onError = error => finish(error);
    const timer = setInterval(() => {
      if (fs.existsSync(file)) {
        finish();
      } else if (child.exitCode !== null || child.signalCode !== null) {
        finish(new Error("Test instance exited before producing a result"));
      } else if (Date.now() >= until) {
        finish(new Error(`Timed out waiting for ${file}`));
      }
    }, 250);
    child.once("error", onError);
  });
}

function helperSource() {
  return String.raw`
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vscode = require("vscode");
const delay = (ms) => new Promise(resolve => setTimeout(resolve, ms));
const runtimeRoot = process.env.JETGIT_RUNTIME_ROOT;
const resultPath = process.env.JETGIT_RUNTIME_RESULT;
const phasePath = process.env.JETGIT_RUNTIME_PHASE;
const fixtureFile = vscode.Uri.file(path.join(runtimeRoot, "fixture", "tracked.txt"));
const historyType = "git-brains.gitLog";
function write(value) { fs.writeFileSync(resultPath, JSON.stringify(value, null, 2)); }
function allTabs() { return vscode.window.tabGroups.all.flatMap(group => group.tabs.map(tab => ({ group, tab }))); }
function isHistoryTab(tab) {
  const input = tab.input;
  return Boolean(input && (
    input.viewType === historyType ||
    (typeof input.viewType === "string" && input.viewType.endsWith("-" + historyType)) ||
    (tab.label === "JetGit" && input.constructor && input.constructor.name === "TabInputWebview")
  ));
}
function historyTabs() { return allTabs().filter(({ tab }) => isHistoryTab(tab)); }
function tabDiagnostics() {
  return allTabs().map(({ group, tab }) => ({
    group: vscode.window.tabGroups.all.indexOf(group),
    label: tab.label,
    inputConstructor: tab.input && tab.input.constructor ? tab.input.constructor.name : typeof tab.input,
    viewType: tab.input && tab.input.viewType,
  }));
}
async function waitFor(predicate, description) {
  const until = Date.now() + 15_000;
  while (Date.now() < until) {
    const value = predicate();
    if (value) return value;
    await delay(100);
  }
  throw new Error("Timed out: " + description);
}
async function openFixtureFile() {
  const editor = await vscode.window.showTextDocument(fixtureFile, { preview: false, viewColumn: vscode.ViewColumn.Active });
  return editor;
}
async function phaseOne() {
  const extension = vscode.extensions.getExtension("jetgit.idea-like-git-graph");
  if (!extension) throw new Error("JetGit VSIX is not installed in isolated extensions directory");
  await extension.activate();
  const fileEditor = await openFixtureFile();
  const originalGroup = vscode.window.tabGroups.activeTabGroup;

  await vscode.commands.executeCommand("git-brains.commitPanel.focus");
  await delay(500);
  assert.equal(historyTabs().length, 0, "opening Commit must not open history");

  await vscode.commands.executeCommand("git-brains.openLog");
  const first = await waitFor(() => historyTabs()[0], "openLog history tab");
  assert.equal(historyTabs().length, 1, "openLog creates one history tab");
  assert.equal(first.group, originalGroup, "first history tab opens in active editor group");
  assert.equal(first.tab.label, "JetGit", "history title is JetGit");

  await vscode.commands.executeCommand("git-brains.gitLog.focus");
  await delay(250);
  assert.equal(historyTabs().length, 1, "legacy focus reuses the history tab");

  // The command only moves into an existing neighbour, so create one first.
  await vscode.commands.executeCommand("workbench.action.newGroupRight");
  await vscode.commands.executeCommand("git-brains.openLog");
  await delay(150);
  await vscode.commands.executeCommand("workbench.action.moveEditorToNextGroup");
  const moved = await waitFor(() => historyTabs()[0], "moved history tab");
  const movedGroup = moved.group;
  assert.notEqual(movedGroup, originalGroup, "move command moves history tab to another group");
  await openFixtureFile();
  await vscode.commands.executeCommand("git-brains.openLog");
  await delay(250);
  assert.equal(historyTabs().length, 1, "reopen after move remains singleton");
  assert.equal(historyTabs()[0].group, movedGroup, "reopen does not move user-positioned tab");

  await vscode.window.tabGroups.close(historyTabs()[0].tab, true);
  await waitFor(() => historyTabs().length === 0, "history tab close");
  await vscode.commands.executeCommand("git-brains.openLog");
  await waitFor(() => historyTabs()[0], "history reopen");
  assert.equal(historyTabs().length, 1, "close and reopen creates one tab");

  await vscode.window.tabGroups.close(historyTabs()[0].tab, true);
  await waitFor(() => historyTabs().length === 0, "close before cold file history");
  await openFixtureFile();
  await vscode.commands.executeCommand("git-brains.showFileHistory", fixtureFile);
  await waitFor(() => historyTabs()[0], "cold file-history opens history");
  assert.equal(historyTabs().length, 1, "cold file-history creates exactly one tab");

  fs.writeFileSync(phasePath, JSON.stringify({ phase: 2, expectedGroupIndex: vscode.window.tabGroups.all.indexOf(historyTabs()[0].group) }));
  return {
    commitDoesNotOpenHistory: true,
    singletonOpenAndLegacyFocus: true,
    opensInCurrentGroup: true,
    keepsUserMovedGroup: true,
    closeAndReopen: true,
    coldFileHistory: true,
    historyGroupIndexBeforeReload: vscode.window.tabGroups.all.indexOf(historyTabs()[0].group),
    activeFileBeforeHistory: fileEditor.document.uri.fsPath,
  };
}
async function phaseTwo(previous) {
  const restored = await waitFor(() => historyTabs()[0], "history panel restoration after reload");
  assert.equal(historyTabs().length, 1, "reload restores exactly one history tab");
  assert.equal(restored.tab.label, "JetGit", "restored tab retains title");
  return {
    ...previous,
    reloadRestoresHistoryTab: true,
    historyGroupIndexAfterReload: vscode.window.tabGroups.all.indexOf(restored.group),
  };
}
async function activate() {
  try {
    const expectedLanguage = process.env.JETGIT_EXPECT_LANGUAGE;
    if (expectedLanguage) {
      assert.equal(vscode.env.language.toLowerCase(), expectedLanguage, "VS Code display language does not match the isolated locale configuration");
    }
    const phase = fs.existsSync(phasePath) ? JSON.parse(fs.readFileSync(phasePath, "utf8")) : { phase: 1 };
    if (phase.phase === 1) {
      const checks = await phaseOne();
      fs.writeFileSync(phasePath, JSON.stringify({ phase: 2, checks }));
      // VS Code terminates this extension host as part of reload. The command
      // can therefore reject with Canceled after the reload was accepted.
      try {
        await vscode.commands.executeCommand("workbench.action.reloadWindow");
      } catch (error) {
        if (!String(error).includes("Canceled")) throw error;
      }
      return;
    }
    const checks = await phaseTwo(phase.checks);
    write({ ok: true, language: vscode.env.language, checks, hostVersion: vscode.version });
    if (process.env.JETGIT_RUNTIME_HOLD !== "true") {
      void vscode.commands.executeCommand("workbench.action.closeWindow").catch(() => {});
    }
  } catch (error) {
    write({ ok: false, language: vscode.env.language, error: String(error && error.stack || error), tabs: tabDiagnostics() });
    void vscode.commands.executeCommand("workbench.action.closeWindow").catch(() => {});
  }
}
exports.activate = activate;
`;
}

async function createFixture(tempRoot) {
  const fixture = path.join(tempRoot, "fixture");
  await fsp.mkdir(fixture, { recursive: true });
  await fsp.writeFile(path.join(fixture, "tracked.txt"), "JetGit runtime fixture\n");
  run("git", ["init"], { cwd: fixture });
  run("git", ["config", "user.name", "JetGit Runtime"], { cwd: fixture });
  run("git", ["config", "user.email", "runtime@example.invalid"], { cwd: fixture });
  run("git", ["add", "tracked.txt"], { cwd: fixture });
  run("git", ["commit", "-m", "runtime fixture"], { cwd: fixture });
  return fixture;
}

async function createHelper(extensionsDir) {
  const helper = path.join(extensionsDir, "jetgit.editor-runtime-check");
  await fsp.mkdir(helper, { recursive: true });
  await fsp.writeFile(path.join(helper, "package.json"), JSON.stringify({
    name: "jetgit-editor-runtime-check",
    displayName: "JetGit editor runtime check",
    version: "0.0.0",
    publisher: "jetgit-test",
    engines: { vscode: "^1.85.0" },
    main: "./extension.js",
    activationEvents: ["onStartupFinished"],
  }, null, 2));
  await fsp.writeFile(path.join(helper, "extension.js"), helperSource());
}

async function provisionLanguagePack(extensionsDir, locale) {
  const identifiers = {
    "zh-cn": "ms-ceintl.vscode-language-pack-zh-hans",
    "zh-tw": "ms-ceintl.vscode-language-pack-zh-hant",
    de: "ms-ceintl.vscode-language-pack-de",
  };
  const identifier = identifiers[locale];
  if (!identifier) return;
  const entries = await fsp.readdir(installedExtensionsDir, { withFileTypes: true }).catch(error => {
    if (error.code === "ENOENT") return [];
    throw error;
  });
  const languagePack = entries.find(entry =>
    entry.isDirectory() && entry.name.startsWith(`${identifier}-`),
  );
  if (languagePack) {
    await fsp.cp(
      path.join(installedExtensionsDir, languagePack.name),
      path.join(extensionsDir, languagePack.name),
      { recursive: true },
    );
    return;
  }
  // The package is installed only into the temporary isolated extensions dir.
  run(code, ["--install-extension", identifier, "--extensions-dir", extensionsDir, "--force"]);
}

function waitForExit(child, timeout = 5_000) {
  return new Promise(resolve => {
    if (child.exitCode !== null || child.signalCode !== null) return resolve();
    const timer = setTimeout(resolve, timeout);
    child.once("exit", () => {
      clearTimeout(timer);
      resolve();
    });
  });
}

async function stopChild(child) {
  if (!child.pid) { activeChildren.delete(child); return; }
  if (child.exitCode === null && child.signalCode === null) child.kill("SIGTERM");
  await waitForExit(child);
  if (child.exitCode === null && child.signalCode === null) {
    child.kill("SIGKILL");
    await waitForExit(child);
  }
  if (child.exitCode === null && child.signalCode === null) {
    throw new Error(`Test instance ${child.pid} did not exit; no further window will be started`);
  }
  activeChildren.delete(child);
}

for (const signal of ["SIGINT", "SIGTERM"]) process.on(signal, () => {
  if (stopping) return;
  stopping = true;
  void Promise.allSettled([...activeChildren].map(stopChild)).then(() => process.exit(130));
});

async function runLocale(tempRoot, locale) {
  assert.ok(!stopping && activeChildren.size === 0, "A previous test instance is still active");
  const userData = path.join(tempRoot, `user-${locale}`);
  const extensions = path.join(tempRoot, `extensions-${locale}`);
  const result = path.join(tempRoot, `result-${locale}.json`);
  await fsp.mkdir(path.join(userData, "User"), { recursive: true });
  await fsp.mkdir(extensions, { recursive: true });
  await fsp.writeFile(path.join(userData, "User", "locale.json"), JSON.stringify({ locale }));
  await createHelper(extensions);
  await provisionLanguagePack(extensions, locale);
  run(code, ["--install-extension", vsix, "--extensions-dir", extensions, "--force"]);
  const child = spawn(codeApp, [
    path.join(tempRoot, "fixture"),
    "--new-window",
    "--locale", locale,
    "--user-data-dir", userData,
    "--extensions-dir", extensions,
    "--disable-workspace-trust",
    "--skip-welcome",
  ], {
    env: {
      ...vscodeCliEnv,
      JETGIT_RUNTIME_ROOT: tempRoot,
      JETGIT_RUNTIME_RESULT: result,
      JETGIT_RUNTIME_PHASE: path.join(tempRoot, `phase-${locale}.json`),
      JETGIT_EXPECT_LANGUAGE: locale,
      JETGIT_RUNTIME_HOLD: "false",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  activeChildren.add(child);
  child.stdout.resume();
  try {
    let stderr = "";
    child.stderr.on("data", data => { stderr += data; });
    await waitForFile(result, child);
    const payload = JSON.parse(await fsp.readFile(result, "utf8"));
    if (!payload.ok) throw new Error(`runtime helper failed for ${locale}: ${payload.error}\n${stderr}`);
    return payload;
  } finally {
    // Every automated locale window is disposable. Stop its main process and
    // wait before the next locale so helper processes cannot accumulate.
    await stopChild(child);
  }
}

async function main() {
  assert.ok(process.argv.includes("--run-gui"), "This check opens isolated VS Code windows. Pass --run-gui only when an interactive test run is intended.");
  assert.ok(fs.existsSync(code), `VS Code CLI not found: ${code}`);
  assert.ok(fs.existsSync(vsix), `VSIX not found: ${vsix}`);
  const tempRoot = await fsp.mkdtemp(path.join(os.tmpdir(), "jetgit-editor-runtime-"));
  try {
    await createFixture(tempRoot);
    const version = run(code, ["--version"]).trim().split(/\s+/);
    const result = {
      generatedAt: new Date().toISOString(),
      vsix: { path: path.relative(root, vsix), sha256: crypto.createHash("sha256").update(await fsp.readFile(vsix)).digest("hex") },
      environment: { vscode: version[0], platform: process.platform, arch: process.arch, fixture: "temporary local Git repository with no remote" },
      languages: {},
      limitations: [
        "The helper extension is created only in the temporary isolated extensions directory and is not included in the VSIX.",
        "This checks VS Code Extension API tab lifecycle and command routing. It does not inspect browser DOM state, persisted file filters or selected revisions, or network traffic.",
      ],
    };
    for (const locale of ["en", "zh-cn", "zh-tw", "de"]) result.languages[locale] = await runLocale(tempRoot, locale);
    await fsp.mkdir(path.dirname(evidencePath), { recursive: true });
    await fsp.writeFile(evidencePath, JSON.stringify(result, null, 2) + "\n");
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await Promise.all([...activeChildren].map(stopChild));
    await fsp.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch(error => {
  console.error(error.stack || error);
  process.exitCode = 1;
});
