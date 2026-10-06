/*
 * Host/UI security and l10n smoke check.
 *
 * Compiles current Host sources with a minimal VS Code runtime stub, then calls
 * the exported HTML builder, MessageRouter, and activate() registration path.
 * File mutations occur only in a disposable Git workspace under the OS temp dir.
 */
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

function git(cwd, args) {
  return childProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
}

function replaceArgs(message, args) {
  return args.reduce(
    (result, arg, index) => result.replace(`{${index}}`, String(arg)),
    message,
  );
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jetgit-host-ui-"));
  try {
    const workspace = path.join(tempRoot, "workspace");
    await fs.mkdir(workspace);
    git(workspace, ["init", "-b", "main"]);
    git(workspace, ["config", "user.name", "JetGit Host UI Check"]);
    git(workspace, ["config", "user.email", "host-ui@example.invalid"]);
    await fs.writeFile(path.join(workspace, "tracked.txt"), "base\n");
    git(workspace, ["add", "tracked.txt"]);
    git(workspace, ["commit", "-m", "initial"]);

    const registeredCommands = new Map();
    let webviewViewProviderCount = 0;
    const vscodeStub = {
      env: { language: "en", clipboard: { writeText: async () => {}, readText: async () => "" } },
      l10n: {
        t(message, ...args) {
          const translated = {
            Rollback: "回退",
            Delete: "删除",
            Discard: "放弃",
            OK: "确定",
            "Unknown command: {0}": "未知命令：{0}",
          }[message] ?? message;
          return replaceArgs(translated, args);
        },
      },
      Uri: {
        file(fsPath) {
          return { fsPath, path: fsPath, scheme: "file", toString: () => `file:${fsPath}` };
        },
        joinPath(base, ...segments) {
          const fsPath = path.join(base.fsPath ?? base.path, ...segments);
          return { fsPath, path: fsPath, scheme: "file", toString: () => `file:${fsPath}` };
        },
        parse(value) {
          return { fsPath: value, path: value, scheme: value.split(":", 1)[0], toString: () => value };
        },
      },
      ViewColumn: { One: 1, Left: 1, Beside: 2, Active: 1 },
      StatusBarAlignment: { Left: 1, Right: 2 },
      Range: class Range {},
      RelativePattern: class RelativePattern { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
      Disposable: class Disposable { constructor(dispose) { this.dispose = dispose; } },
      EventEmitter: class EventEmitter { constructor() { this.event = () => new vscodeStub.Disposable(() => {}); } fire() {} },
      FileType: { File: 0 },
      FileSystemError: { NoPermissions: (message) => new Error(message) },
      window: {
        registerWebviewViewProvider: () => {
          webviewViewProviderCount++;
          return { dispose() {} };
        },
        registerWebviewPanelSerializer: () => ({ dispose() {} }),
        onDidChangeActiveColorTheme: () => ({ dispose() {} }),
        showWarningMessage: async (_message, _options, button) => button,
        showInformationMessage: async () => undefined,
        showErrorMessage: async () => undefined,
        createWebviewPanel: () => { throw new Error("Panel creation is outside this Host registration test"); },
        createStatusBarItem: () => ({ show() {}, dispose() {} }),
      },
      workspace: {
        workspaceFolders: [{ uri: { fsPath: workspace } }],
        registerTextDocumentContentProvider: () => ({ dispose() {} }),
        registerFileSystemProvider: () => ({ dispose() {} }),
        onDidChangeWorkspaceFolders: () => ({ dispose() {} }),
        onDidSaveTextDocument: () => ({ dispose() {} }),
        createFileSystemWatcher: () => ({
          onDidChange: () => ({ dispose() {} }),
          onDidCreate: () => ({ dispose() {} }),
          onDidDelete: () => ({ dispose() {} }),
          dispose() {},
        }),
        fs: { delete: async (uri) => fs.rm(uri.fsPath, { recursive: true, force: true }) },
      },
      commands: {
        registerCommand: (id, callback) => {
          registeredCommands.set(id, callback);
          return { dispose() {} };
        },
        executeCommand: async () => undefined,
      },
      extensions: { getExtension: () => undefined },
    };
    global.__jetgitVscodeStub = vscodeStub;

    const entry = path.join(tempRoot, "entry.ts");
    const bundle = path.join(tempRoot, "host-ui.cjs");
    const stubModule = path.join(tempRoot, "vscode-stub.cjs");
    await fs.writeFile(stubModule, "module.exports = global.__jetgitVscodeStub;\n");
    await fs.writeFile(
      entry,
      `export { getWebviewHtml } from ${JSON.stringify(path.join(projectRoot, "src/views/html.ts"))};\n` +
        `export { MessageRouter } from ${JSON.stringify(path.join(projectRoot, "src/messages/messageRouter.ts"))};\n` +
        `export { activate } from ${JSON.stringify(path.join(projectRoot, "src/extension.ts"))};\n`,
    );
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundle,
      plugins: [{ name: "vscode-test-stub", setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: stubModule }));
      } }],
    });
    const { getWebviewHtml } = require(bundle);

    const webview = {
      cspSource: "vscode-webview://test",
      asWebviewUri: (uri) => `webview:${uri.fsPath}`,
    };
    const extensionUri = vscodeStub.Uri.file("/extension");
    const modes = ["panel", "merge", "conflicts", "cvs", "push", "rollback"];
    for (const mode of modes) {
      vscodeStub.env.language = "zh-tw";
      const html = getWebviewHtml(webview, extensionUri, mode, { branch: `x\"><script>${mode}</script>` });
      assert.match(html, /<html lang="zh-cn">/);
      assert.match(html, new RegExp(`data-mode="${mode}"`));
      assert.match(html, /data-language="zh-tw"/);
      assert.ok(!html.includes("<script>panel</script>"));
      assert.match(html, /&quot;&gt;&lt;script&gt;/);
      assert.match(html, /default-src 'none';/);
      assert.ok(!html.includes("connect-src"));
    }
    for (const [language, expectedHtmlLanguage] of [["zh", "zh-cn"], ["zh-cn", "zh-cn"], ["fr", "en"]]) {
      vscodeStub.env.language = language;
      const html = getWebviewHtml(webview, extensionUri, "panel");
      assert.match(html, new RegExp(`<html lang="${expectedHtmlLanguage}">`));
      assert.match(html, new RegExp(`data-language="${language}"`));
    }
    vscodeStub.env.language = `\"><script>language</script>`;
    const hostileLanguageHtml = getWebviewHtml(webview, extensionUri, "panel");
    assert.match(hostileLanguageHtml, /<html lang="en">/);
    assert.match(hostileLanguageHtml, /data-language="&quot;&gt;&lt;script&gt;language&lt;\/script&gt;"/);

    console.log(JSON.stringify({
      htmlModes: modes.length,
      languageNormalization: ["en", "zh", "zh-cn", "zh-tw", "other"],
      escapedHostileAttributes: true,
      cspNoConnectSource: true,
      note: "HTML builder only; actual Host routing is covered by workspace-host-check.cjs"
    }));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
