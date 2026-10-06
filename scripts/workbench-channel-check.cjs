/* Strict catalog/comparison webview channel checks with no VS Code window. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

const repositoryId = "a".repeat(64);
function rejects(action, label) { return assert.rejects(action, undefined, label); }
async function main() {
  const project = path.resolve(__dirname, "..");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jettortoise-workbench-channel-"));
  try {
    const entry = path.join(temp, "entry.ts");
    const bundle = path.join(temp, "channel.cjs");
    const stub = path.join(temp, "vscode.cjs");
    await fs.writeFile(stub, `
      class Disposable { constructor(fn) { this.dispose=fn||(()=>{}); } }
      exports.Disposable=Disposable;
      exports.l10n={t:(message,...values)=>values.reduce((text,value,index)=>text.replace("{"+index+"}",String(value)),message)};
    `);
    await fs.writeFile(entry, `export * from ${JSON.stringify(path.join(project, "src/repositories/catalog-channel.ts"))};`);
    await esbuild.build({ entryPoints:[entry], bundle:true, platform:"node", format:"cjs", outfile:bundle, plugins:[{name:"vscode",setup(build){build.onResolve({filter:/^vscode$/},()=>({path:stub}));}}] });
    const api = require(bundle);

    const validCatalog = { type:"jettortoiseCatalog", id:"one", action:"open", repositoryId };
    assert.equal(api.parseCatalogRequest(validCatalog), "open");
    await rejects(async () => api.parseCatalogRequest({ ...validCatalog, cwd:"/tmp/other" }), "catalog arbitrary cwd field");
    await rejects(async () => api.parseCatalogRequest({ ...validCatalog, action:"shell" }), "unknown catalog action");
    await rejects(async () => api.parseCatalogRequest({ type:"jettortoiseCatalog", id:"two", action:"scan", repositoryId }), "global action foreign repository id");
    await rejects(async () => api.parseCatalogRequest({ type:"jettortoiseCatalog", id:"three", action:"open", repositoryId:"not-an-id" }), "malformed repository id");
    await rejects(async () => api.parseComparisonRequest({ type:"jettortoiseComparison", id:"four", action:"preview", selection:{source:"history",filePath:"../secret",revision:"HEAD"} }), "comparison path traversal");
    await rejects(async () => api.parseComparisonRequest({ type:"jettortoiseComparison", id:"five", action:"preview", selection:{source:"history",filePath:"tracked.txt",revision:""} }), "empty history revision");
    await rejects(async () => api.parseComparisonRequest({ type:"jettortoiseComparison", id:"six", action:"preview", selection:{source:"working",filePath:"tracked.txt",revision:"HEAD"} }), "working revision injection");

    const messages = [];
    let receiver;
    const webview = {
      postMessage: async (message) => { messages.push(message); return true; },
      onDidReceiveMessage(listener) { receiver=listener; return { dispose() {} }; },
    };
    let changed;
    const actions = [];
    const catalog = {
      snapshot: () => ({ entries:[{ id:repositoryId }], scanning:false }),
      subscribe(listener) { changed=listener; return { dispose() { changed=undefined; } }; },
      async action(action, id) {
        actions.push({ action, id });
        if (id !== undefined && id !== repositoryId) throw new Error("Unknown repository");
        return { action, id };
      },
    };
    let available = 0;
    let compareSelection;
    const binding = api.bindWorkbenchChannel(webview, { catalog }, async () => { available++; }, async (action, selection) => {
      compareSelection={action,selection}; return { ok:true };
    });
    await receiver(validCatalog);
    assert.deepEqual(actions, [{ action:"open", id:repositoryId }], "catalog action received anything except its opaque ID");
    assert.equal(messages.at(-1).ok, true);
    changed();
    assert.equal(messages.at(-1).type, "jettortoiseCatalogSnapshot", "catalog change did not publish snapshot");
    await receiver({ ...validCatalog, id:"foreign", repositoryId:"b".repeat(64) });
    assert.equal(actions.at(-1).id, "b".repeat(64), "catalog channel rewrote foreign ID");
    assert.equal(messages.at(-1).ok, false, "foreign ID did not reject through catalog authority");
    await receiver({ ...validCatalog, id:"extra", command:"git -C /tmp status" });
    assert.equal(messages.at(-1).ok, false, "extra catalog field was accepted");
    await receiver({ type:"jettortoiseComparison", id:"compare", action:"preview", selection:{source:"history",filePath:"a.txt",revision:"HEAD"} });
    assert.equal(available, 1);
    assert.deepEqual(compareSelection, { action:"preview", selection:{source:"history",filePath:"a.txt",revision:"HEAD"} });

    let resolveSlow;
    const slow = api.bindWorkbenchChannel(webview, { catalog }, async () => {}, () => new Promise((resolve) => { resolveSlow=resolve; }));
    const beforeLate = messages.length;
    const pending = receiver({ type:"jettortoiseComparison", id:"late", action:"file", selection:{source:"working",filePath:"a.txt"} });
    await Promise.resolve();
    await Promise.resolve();
    assert.equal(typeof resolveSlow, "function", "late comparison never reached its handler");
    slow.dispose(); resolveSlow({ content:"late" }); await pending;
    assert.equal(messages.length, beforeLate, "disposed panel emitted late response");
    binding.dispose();
    console.log(JSON.stringify({ checks: 16, strictCatalog: true, comparisonBound: true, lateResponseSuppressed: true }));
  } finally { await fs.rm(temp, { recursive:true, force:true }); }
}
main().catch((error) => { console.error(error); process.exitCode=1; });
