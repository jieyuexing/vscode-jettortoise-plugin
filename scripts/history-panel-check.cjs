/*
 * Exercises the history editor tab lifecycle with a minimal VS Code runtime.
 * The source is bundled directly so this validates the current Host classes.
 */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

function disposable() {
  return { dispose() {} };
}

function createPanel(viewType, title, column, options) {
  const listeners = [];
  const disposeListeners = [];
  const panel = {
    viewType,
    title,
    column,
    options,
    revealCalls: [],
    disposed: false,
    webview: {
      options: {},
      html: "",
      messages: [],
      onDidReceiveMessage(listener) {
        listeners.push(listener);
        return disposable();
      },
      postMessage(message) {
        this.messages.push(message);
        return Promise.resolve(true);
      },
      emit(message) {
        for (const listener of listeners) listener(message);
      },
      cspSource: "vscode-webview://history-check",
      asWebviewUri: (uri) => `webview:${uri.fsPath}`,
    },
    active: true,
    onDidChangeViewState() { return disposable(); },
    reveal(target) {
      this.revealCalls.push(target);
    },
    onDidDispose(listener) {
      disposeListeners.push(listener);
      return disposable();
    },
    dispose() {
      this.disposed = true;
      for (const listener of disposeListeners) listener();
    },
  };
  return panel;
}

async function main() {
  const projectRoot = path.resolve(__dirname, "..");
  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "jetgit-history-"));
  try {
    const panels = [];
    const registeredSerializers = new Map();
    const commandCalls = [];
    const vscodeStub = {
      env: { language: "en" },
      Uri: {
        file(fsPath) {
          return { fsPath, path: fsPath, scheme: "file" };
        },
        joinPath(base, ...segments) {
          const fsPath = path.join(base.fsPath ?? base.path, ...segments);
          return { fsPath, path: fsPath, scheme: "file" };
        },
      },
      ViewColumn: { Active: 17 },
      window: {
        createWebviewPanel(viewType, title, column, options) {
          const panel = createPanel(viewType, title, column, options);
          panels.push(panel);
          return panel;
        },
        registerWebviewPanelSerializer(viewType, serializer) {
          registeredSerializers.set(viewType, serializer);
          return disposable();
        },
      },
      commands: {
        executeCommand(...args) {
          commandCalls.push(args);
          return Promise.resolve();
        },
      },
    };
    global.__jetgitVscodeStub = vscodeStub;

    const stubModule = path.join(tempRoot, "vscode-stub.cjs");
    const entry = path.join(tempRoot, "entry.ts");
    const bundle = path.join(tempRoot, "history.cjs");
    await fs.writeFile(stubModule, "module.exports = global.__jetgitVscodeStub;\n");
    await fs.writeFile(
      entry,
      `export { GitLogViewProvider } from ${JSON.stringify(path.join(projectRoot, "src/views/gitLogViewProvider.ts"))};\n`,
    );
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundle,
      plugins: [{ name: "vscode-stub", setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: stubModule }));
      } }],
    });
    const { GitLogViewProvider } = require(bundle);
    const registrations = [];
    const router = {
      registerWebview(webview) {
        registrations.push(webview);
        return disposable();
      },
      broadcastEvent() {},
    };
    const extensionUri = vscodeStub.Uri.file("/extension");
    const history = new GitLogViewProvider(extensionUri, router, undefined, { id: "example", kind: "git", root: "/example", title: "JetTortoise · example [Git]" }, () => {});

    history.showFileHistory("first.txt");
    history.showFileHistory("latest.txt");
    history.openCommit();
    assert.equal(panels.length, 1);
    const firstPanel = panels[0];
    assert.equal(firstPanel.viewType, "jettortoise.workspace");
    assert.equal(firstPanel.title, "JetTortoise · example [Git]");
    assert.equal(firstPanel.column, vscodeStub.ViewColumn.Active);
    assert.equal(firstPanel.options.retainContextWhenHidden, true);
    assert.match(firstPanel.webview.html, /data-mode="panel"/);
    assert.equal(firstPanel.webview.messages.length, 0);
    firstPanel.webview.emit({ type: "otherReady" });
    assert.equal(firstPanel.webview.messages.length, 0);
    firstPanel.webview.emit({ type: "jettortoiseHistoryReady" });
    assert.deepEqual(firstPanel.webview.messages, [
      {
        type: "event",
        event: "showFileHistory",
        data: { file: "latest.txt" },
      },
      {
        type: "event",
        event: "showCommitPanel",
        data: {},
      },
    ]);
    history.open();
    assert.deepEqual(firstPanel.revealCalls, [
      undefined,
      undefined,
      undefined,
    ]);

    history.showFileHistory("discard-on-close.txt");
    history.openCommit();
    firstPanel.dispose();
    history.open();
    const secondPanel = panels[1];
    secondPanel.webview.emit({ type: "jettortoiseHistoryReady" });
    assert.equal(secondPanel.webview.messages.length, 0);
    history.showFileHistory("after-close.txt");
    history.openCommit();
    assert.deepEqual(secondPanel.webview.messages, [
      {
        type: "event",
        event: "showFileHistory",
        data: { file: "after-close.txt" },
      },
      {
        type: "event",
        event: "showCommitPanel",
        data: {},
      },
    ]);

    const duplicateRestore = createPanel("jettortoise.workspace", "Old title", 99, {});
    await history.deserializeWebviewPanel(duplicateRestore, {});
    assert.equal(duplicateRestore.disposed, true);
    secondPanel.dispose();

    const restoredPanel = createPanel("jettortoise.workspace", "Old title", 99, {});
    await history.deserializeWebviewPanel(restoredPanel, {});
    assert.equal(restoredPanel.title, "JetTortoise · example [Git]");
    assert.equal(restoredPanel.webview.options.enableScripts, true);
    assert.match(restoredPanel.webview.html, /data-mode="panel"/);
    assert.equal(registrations.length, 3);

    assert.deepEqual(commandCalls, []);

    console.log(JSON.stringify({
      singletonPanel: true,
      currentEditorGroup: true,
      readyQueue: true,
      disposeCleanup: true,
      reloadRestore: true,
      independentFileHistoryAndCommitQueues: true,
      commitFocusUsesRepositoryTab: true,
    }));
  } finally {
    await fs.rm(tempRoot, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
