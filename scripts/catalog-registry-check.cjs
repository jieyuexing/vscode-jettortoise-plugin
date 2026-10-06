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
    console.log(JSON.stringify({ checks: 10, v1Migration: true, unavailableRetained: true, hiddenUnavailableReversible: true }));
  } finally { await fs.rm(temp, { recursive:true, force:true }); }
}
main().catch((error) => { console.error(error); process.exitCode=1; });
