/* Persistence migration and unavailable-record behaviour for catalog state. */
const assert = require("node:assert/strict");
const childProcess = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

async function main() {
  const project = path.resolve(__dirname, "..");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jettortoise-catalog-registry-"));
  try {
    const source = path.join(temp, "entry.ts");
    const bundle = path.join(temp, "registry.cjs");
    const vscodeStub = path.join(temp, "vscode.cjs");
    await fs.writeFile(vscodeStub, `
      class Disposable { constructor(fn) { this.dispose = fn || (() => {}); } }
      class Uri { constructor(value) { Object.assign(this, value); this.fsPath=value.fsPath||value.path||""; } static file(fsPath) { return new Uri({scheme:"file",fsPath,path:fsPath}); } }
      const state = global.__catalogVscode || (global.__catalogVscode={workspace:{isTrusted:true,workspaceFolders:[]}});
      exports.workspace=state.workspace; exports.Uri=Uri; exports.Disposable=Disposable;
      exports.l10n={t:(message,...values)=>values.reduce((value,current,index)=>value.replace("{"+index+"}",String(current)),message)};
      exports.window={showQuickPick:async items=>items[0],showOpenDialog:async()=>undefined,showInformationMessage:async()=>undefined};
      exports.commands={executeCommand:async()=>{}};
      exports.FileSystemError={NoPermissions:()=>new Error("NoPermissions"),FileNotFound:()=>new Error("FileNotFound")};
    `);
    await fs.writeFile(source, `export * from ${JSON.stringify(path.join(project, "src/repositories/registry.ts"))};`);
    await esbuild.build({ entryPoints:[source], bundle:true, platform:"node", format:"cjs", outfile:bundle, plugins:[{name:"vscode",setup(build){build.onResolve({filter:/^vscode$/},()=>({path:vscodeStub}));}}] });
    const vscode = require(vscodeStub);
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(temp) }];
    const api = require(bundle);
    const missing = path.join(temp, "saved-but-missing");
    const legacyWrites = [];
    new api.RepositoryRegistry(() => ({ open(){}, restore(){}, refresh(){}, async provideContent(){return "";}, dispose(){} }), {
      registered: { version: 1, repositories: [{ kind:"git", root:missing }] },
      save(value) { legacyWrites.push(value); },
    });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(legacyWrites.length, 1, "v1 state was not migrated without a scan/add");
    assert.equal(legacyWrites[0].version, 2);
    assert.equal(legacyWrites[0].repositories[0].origin, "manual");

    const registry = new api.RepositoryRegistry(() => ({ open(){}, restore(){}, refresh(){}, async provideContent(){return "";}, dispose(){} }), {
      registered: { version: 2, repositories: [{ kind:"git", root:missing, origin:"manual" }] },
      save() {},
    });
    await registry.ready();
    const entry = registry.snapshot().entries[0];
    assert.equal(entry.repository.root, missing);
    assert.equal(entry.origin, "manual");
    assert.equal(entry.availability, "unavailable", "unavailable saved root was discarded instead of retained without an automatic scan");
    const hiddenRegistry = new api.RepositoryRegistry(() => ({ open(){}, restore(){}, refresh(){}, async provideContent(){return "";}, dispose(){} }), {
      registered: { version: 2, repositories: [{ kind:"git", root:missing, origin:"manual", hidden:true }] }, save() {},
    });
    await hiddenRegistry.ready();
    const id = hiddenRegistry.snapshot().entries[0].repository.id;
    await hiddenRegistry.restoreHidden(id);
    assert.equal(hiddenRegistry.snapshot().entries[0].availability, "unavailable", "restored missing root became operable");
    await hiddenRegistry.remove(id);
    assert.equal(hiddenRegistry.snapshot().entries[0].hidden, true, "unavailable restored root could not be hidden again");
    hiddenRegistry.dispose();
    registry.dispose();

    // 修正 A：完整扫描删除没再发现的自动登记，手动登记只标不可用，不完整扫描不动。
    const workspace = await fs.realpath(await fs.mkdtemp(path.join(temp, "scan-")));
    vscode.workspace.workspaceFolders = [{ uri: vscode.Uri.file(workspace) }];
    const gitInit = (root) => childProcess.execFileSync("git", ["init", "-q", "-b", "main"], { cwd: root });
    gitInit(workspace);
    const autoRoot = path.join(workspace, "auto"), manualRoot = path.join(workspace, "manual");
    for (const root of [autoRoot, manualRoot]) { await fs.mkdir(root); gitInit(root); }
    const copy = path.join(workspace, "copy"), build = path.join(copy, "build");
    for (const [dir, repository] of [[copy, "proj"], [build, "proj/build"]]) {
      await fs.mkdir(path.join(dir, "CVS"), { recursive: true });
      await fs.writeFile(path.join(dir, "CVS", "Root"), ":local:/fixture\n");
      await fs.writeFile(path.join(dir, "CVS", "Repository"), `${repository}\n`);
      await fs.writeFile(path.join(dir, "CVS", "Entries"), "");
    }
    const cancelled = [];
    let savedState;
    const scanRegistry = new api.RepositoryRegistry((repository) => ({ open(){}, restore(){}, refresh(){}, async provideContent(){return "";}, cancel(){ cancelled.push(repository.id); }, dispose(){} }), {
      save(value) { savedState = value; },
    });
    await scanRegistry.ready();
    const autoId = api.repositoryDescriptor("git", autoRoot).id;
    const manual = api.repositoryDescriptor("git", manualRoot);
    const buildManual = api.repositoryDescriptor("cvs", build);
    await scanRegistry.scanWorkspace();
    const entryOf = (id) => scanRegistry.snapshot().entries.find((item) => item.repository.id === id);
    assert.equal(entryOf(autoId)?.origin, "auto");
    assert.equal(entryOf(buildManual.id), undefined, "same-project CVS directory was auto-registered");
    await scanRegistry.register(manual);
    await scanRegistry.register(buildManual);
    await scanRegistry.session(scanRegistry.repositories.get(autoId));
    await fs.rm(path.join(autoRoot, ".git"), { recursive: true });
    await fs.rm(path.join(manualRoot, ".git"), { recursive: true });
    const abort = new AbortController(); abort.abort();
    await scanRegistry.scanWorkspace({ signal: abort.signal });
    assert.equal(entryOf(autoId)?.availability, "available", "cancelled scan changed a stale automatic entry");
    assert.equal(entryOf(manual.id)?.availability, "available", "cancelled scan changed a manual entry");
    // 扫描只读元数据：PATH 前置一个记录调用的假 git，完整扫描期间不得被调用。
    const fakeBin = path.join(temp, "fake-bin"), gitMarker = path.join(temp, "git-called");
    await fs.mkdir(fakeBin);
    await fs.writeFile(path.join(fakeBin, "git"), `#!/bin/sh\necho called >> ${JSON.stringify(gitMarker)}\nexit 1\n`, { mode: 0o755 });
    const originalPath = process.env.PATH;
    process.env.PATH = `${fakeBin}${path.delimiter}${originalPath}`;
    try { await scanRegistry.scanWorkspace(); } finally { process.env.PATH = originalPath; }
    await assert.rejects(fs.access(gitMarker), "complete scan invoked the Git CLI");
    assert.equal(entryOf(autoId), undefined, "complete scan kept a stale automatic entry");
    assert.ok(!savedState.repositories.some((item) => item.root === autoRoot), "stale automatic entry was persisted");
    assert.equal(scanRegistry.hidden?.has?.(autoId) ?? false, false);
    assert.deepEqual(cancelled, [autoId], "stale automatic entry kept its session active");
    assert.equal(entryOf(manual.id)?.availability, "unavailable", "missing manual entry was not marked unavailable");
    assert.equal(entryOf(buildManual.id)?.availability, "available", "manual same-project directory became unavailable after a complete scan");
    gitInit(autoRoot);
    await scanRegistry.scanWorkspace();
    assert.equal(entryOf(autoId)?.origin, "auto", "rediscovered automatic entry did not return");
    scanRegistry.dispose();
    console.log(JSON.stringify({ checks: 24, scanWithoutGitCli: true, v1Migration: true, unavailableRetained: true, hiddenUnavailableReversible: true, staleAutoRemoved: true, manualRetained: true, incompleteScanUnchanged: true }));
  } finally { await fs.rm(temp, { recursive:true, force:true }); }
}
main().catch((error) => { console.error(error); process.exitCode=1; });
