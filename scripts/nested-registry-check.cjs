/* Explicit-registration and nested-boundary checks with temporary repositories. */
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

function git(cwd, args) {
  return childProcess.execFileSync("git", args, { cwd, encoding: "utf8" });
}
async function gitRoot(root, content = "tracked\n") {
  await fs.mkdir(root, { recursive: true });
  git(root, ["init", "-b", "main"]);
  git(root, ["config", "user.name", "Nested Registry"]);
  git(root, ["config", "user.email", "nested-registry@example.invalid"]);
  await fs.writeFile(path.join(root, "tracked.txt"), content);
  git(root, ["add", "tracked.txt"]);
  git(root, ["commit", "-m", "initial"]);
  return fs.realpath(root);
}
async function rejects(action, label) {
  await assert.rejects(action, undefined, label);
}

async function main() {
  const project = path.resolve(__dirname, "..");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jettortoise-nested-registry-"));
  try {
    const outer = await gitRoot(path.join(temp, "platform"), "outer\n");
    const middle = await gitRoot(path.join(outer, "plugins", "editor"), "middle\n");
    const inner = await gitRoot(path.join(middle, "client"), "inner\n");
    const cvs = path.join(outer, "legacy", "client");
    await fs.mkdir(path.join(cvs, "CVS"), { recursive: true });
    await fs.writeFile(path.join(cvs, "CVS", "Root"), ":local:/fixture\n");
    await fs.writeFile(path.join(cvs, "CVS", "Repository"), "legacy/client\n");
    await fs.writeFile(path.join(cvs, "CVS", "Entries"), "/tracked.txt/1.1///\n");
    await fs.writeFile(path.join(cvs, "tracked.txt"), "cvs\n");

    const entry = path.join(temp, "entry.ts");
    const bundle = path.join(temp, "registry.cjs");
    const stub = path.join(temp, "vscode.cjs");
    await fs.writeFile(
      stub,
      `
class Disposable { constructor(fn) { this.dispose = fn || (() => {}); } }
class Uri { constructor(value) { Object.assign(this, value); this.fsPath = value.fsPath || value.path || ""; } static file(fsPath) { return new Uri({scheme:"file",fsPath,path:fsPath,authority:"",query:""}); } static from(value) { return new Uri(value); } }
const state = global.__nestedRegistryVscode || (global.__nestedRegistryVscode = { workspace: { isTrusted: true, workspaceFolders: [] }, addPrompts: 0 });
exports.workspace = state.workspace;
exports.Uri = Uri; exports.Disposable = Disposable;
exports.l10n = { t: (message, ...values) => values.reduce((result, value, index) => result.replace("{" + index + "}", String(value)), message) };
exports.window = {
  showQuickPick: async items => items[0],
  showOpenDialog: async () => undefined,
  showInformationMessage: async (message, ...items) => { if (message.startsWith("This repository has not been added:")) { state.addPrompts++; return state.cancelAdd ? undefined : items[0]; } },
};
exports.commands = { executeCommand: async () => {} };
exports.FileSystemError = { NoPermissions: () => new Error("NoPermissions"), FileNotFound: () => new Error("FileNotFound") };
exports.__state = state;
`,
    );
    await fs.writeFile(
      entry,
      `export * from ${JSON.stringify(path.join(project, "src/repositories/registry.ts"))};\nexport * from ${JSON.stringify(path.join(project, "src/repositories/navigation.ts"))};\n`,
    );
    await esbuild.build({
      entryPoints: [entry],
      bundle: true,
      platform: "node",
      format: "cjs",
      outfile: bundle,
      plugins: [
        {
          name: "vscode-stub",
          setup(build) {
            build.onResolve({ filter: /^vscode$/ }, () => ({ path: stub }));
          },
        },
      ],
    });
    global.__nestedRegistryVscode = {
      workspace: { isTrusted: true, workspaceFolders: [] },
      addPrompts: 0,
    };
    const api = require(bundle);
    const vscode = require(stub);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(temp) }];

    const outerDescriptor = api.repositoryDescriptor("git", outer);
    const middleDescriptor = api.repositoryDescriptor("git", middle);
    const innerDescriptor = api.repositoryDescriptor("git", inner);
    const cvsDescriptor = api.repositoryDescriptor("cvs", await fs.realpath(cvs));
    const guards = new Map();
    const sessions = new Map();
    const registry = new api.RepositoryRegistry((repository, guard) => {
      guards.set(repository.id, guard);
      const session = {
        open() {}, restore() {}, refresh() {},
        async provideContent() { return repository.id; },
        cancel() {}, dispose() {},
      };
      sessions.set(repository.id, session);
      return session;
    });

    // Looking at a nested file discovers candidates for this action only; it
    // must never add the child or its Git ancestors to the persistent list.
    assert.deepEqual(await registry.discover(), []);
    assert.deepEqual(await registry.discover(vscode.Uri.file(path.join(inner, "tracked.txt"))), []);
    assert.deepEqual(
      (await registry.candidates(vscode.Uri.file(path.join(inner, "tracked.txt")))).map(item => item.id),
      [innerDescriptor.id],
    );

    // The file entry point offers Add and Open for the nearest root, then a
    // subsequent open is bound to the same registered singleton.
    const chosenInner = await registry.choose(vscode.Uri.file(path.join(inner, "tracked.txt")));
    assert.equal(chosenInner?.id, innerDescriptor.id);
    assert.equal(vscode.__state.addPrompts, 1);
    const innerSession = await registry.session(chosenInner);
    assert.equal(await registry.session(chosenInner), innerSession);
    assert.deepEqual((await registry.discover()).map(item => item.id), [innerDescriptor.id]);

    // A CVS child cannot be redirected to an enclosing Git parent when a Git
    // command is invoked. The nearest physical root wins before kind filtering.
    assert.equal(
      await registry.choose(vscode.Uri.file(path.join(cvs, "tracked.txt")), "git"),
      undefined,
    );
    assert.equal(registry.repositories.has(outerDescriptor.id), false);

    await registry.register(outerDescriptor);
    await registry.register(middleDescriptor);
    await registry.register(cvsDescriptor);
    const hierarchy = registry.hierarchy();
    assert.deepEqual(
      hierarchy.map(item => [item.repository.id, item.depth]),
      [
        [outerDescriptor.id, 0],
        [cvsDescriptor.id, 1],
        [middleDescriptor.id, 1],
        [innerDescriptor.id, 2],
      ],
    );

    // Removing a registration blocks existing pages immediately but retains
    // their session object/draft until exactly that root is added again.
    await registry.remove(innerDescriptor.id);
    await rejects(() => guards.get(innerDescriptor.id)(), "removed page guard");
    await rejects(() => registry.session(innerDescriptor), "removed session");
    await registry.register(innerDescriptor);
    assert.equal(await registry.session(innerDescriptor), innerSession);

    // Legacy storage supplies only a picker candidate, never an implicit
    // registration or URI restoration capability.
    const legacy = new api.RepositoryRegistry(
      () => ({ open() {}, restore() {}, refresh() {}, async provideContent() { return ""; }, dispose() {} }),
      { saved: [{ kind: "git", root: outer }], save() {} },
    );
    assert.deepEqual(await legacy.discover(), []);
    await rejects(
      () => legacy.resolveUri(vscode.Uri.from({ scheme: "jettortoise", authority: outerDescriptor.id, path: "/tracked.txt" })),
      "legacy unregistered URI",
    );
    legacy.dispose();
    // Cancel a nearest child: no ancestor is selected or implicitly registered.
    await registry.remove(innerDescriptor.id);
    vscode.__state.cancelAdd = true;
    assert.equal(await registry.choose(vscode.Uri.file(path.join(inner, "tracked.txt"))), undefined);
    assert.equal(registry.repositories.has(innerDescriptor.id), false);
    const restoredPanel = { savedDraft: "keep this CVS draft" };
    let restored, restoreGuard;
    const restoreRegistry = new api.RepositoryRegistry((repository, guard) => {
      restoreGuard = guard;
      return { open() {}, restore(panel) { restored = panel; }, refresh() {}, dispose() {}, provideContent: async () => "" };
    });
    await restoreRegistry.restore(restoredPanel, { repository: { kind: "cvs", root: cvs } });
    assert.equal(restored, restoredPanel);
    assert.equal(restored.savedDraft, "keep this CVS draft");
    await rejects(() => restoreGuard(), "cancelled restored registration cannot operate");
    await restoreRegistry.register(cvsDescriptor);
    await restoreGuard();
    restoreRegistry.dispose();
    vscode.__state.cancelAdd = false;
    await registry.register(innerDescriptor);

    // Child actions accept only IDs enumerated by this Host, never client cwd.
    let opened;
    const nav = new api.BoundaryNavigation(outerDescriptor, {
      children: () => [middleDescriptor], open: async root => { opened = root; },
    });
    const notices = await nav.list([innerDescriptor, cvsDescriptor]);
    assert.equal(notices.find(item => item.id === middleDescriptor.id).added, true);
    assert.equal(notices.find(item => item.id === cvsDescriptor.id).added, false);
    await rejects(() => nav.open("0".repeat(64)), "forged boundary id");
    await nav.open(cvsDescriptor.id);
    assert.equal(opened, cvs);
    await nav.list([]);
    await rejects(() => nav.open(cvsDescriptor.id), "stale boundary id");

    // Replacing the physical root between queued operations invalidates guards.
    await fs.rename(path.join(inner, ".git"), path.join(inner, ".saved-git"));
    git(inner, ["init", "-b", "main"]);
    await rejects(() => guards.get(innerDescriptor.id)(), "replaced repository identity");
    await fs.rm(path.join(inner, ".git"), { recursive: true });
    await fs.rename(path.join(inner, ".saved-git"), path.join(inner, ".git"));

    // An independent child-window must never borrow or list an ancestor root.
    vscode.workspace.workspaceFolders = [{uri:vscode.Uri.file(middle)}];
    const childWindow = new api.RepositoryRegistry(() => ({open(){},restore(){},refresh(){},dispose(){},provideContent:async()=>""}));
    assert.deepEqual((await childWindow.candidates()).map(item=>item.root),[middle]);
    await rejects(()=>childWindow.register(outerDescriptor),"ancestor root outside child window");
    const plain = path.join(middle,"plain"); await fs.mkdir(plain);
    vscode.workspace.workspaceFolders = [{uri:vscode.Uri.file(plain)}];
    assert.deepEqual(await childWindow.candidates(),[]);
    await rejects(()=>childWindow.choose(vscode.Uri.file(plain)),"plain subdirectory does not silently use outer Git");
    childWindow.dispose();
    registry.dispose();
    console.log(JSON.stringify({
      checks: 22,
      noAutoDiscover: true,
      nearestChildOnly: true,
      childWindowDoesNotBorrowOuterRoot: true,
      hierarchy: true,
      removeAndReaddRetainsSession: true,
      legacyDoesNotRegister: true,
      cancelledRestoreKeepsPageButDeniesOperations: true,
      forgedAndStaleBoundaryIdsRejected: true,
      replacedRootRejected: true,
    }));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
