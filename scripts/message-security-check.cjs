/* Headless contract test for the untrusted webview message boundary. */
const assert = require("node:assert/strict");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const esbuild = require("esbuild");

async function main() {
  const root = path.resolve(__dirname, "..");
  const temp = await fs.mkdtemp(path.join(os.tmpdir(), "jettortoise-message-"));
  try {
    const stub = path.join(temp, "vscode.cjs");
    const entry = path.join(temp, "entry.ts");
    const bundle = path.join(temp, "router.cjs");
    await fs.writeFile(stub, "module.exports = global.__vscodeStub;\n");
    await fs.writeFile(
      entry,
      `export * from ${JSON.stringify(path.join(root, "src/messages/messageRouter.ts"))};\n`,
    );
    global.__vscodeStub = { l10n: { t: (message, ...args) => message.replace("{0}", args[0] ?? "") } };
    await esbuild.build({
      entryPoints: [entry], bundle: true, platform: "node", format: "cjs", outfile: bundle,
      plugins: [{ name: "vscode-stub", setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: stub }));
      } }],
    });
    const { MessageRouter } = require(bundle);
    const sent = [];
    let receive;
    const webview = {
      onDidReceiveMessage(handler) { receive = handler; return { dispose() {} }; },
      postMessage(message) { sent.push(message); return Promise.resolve(true); },
    };
    let available = 0;
    let executed = 0;
    let confirmed = 0;
    const router = new MessageRouter({
      ensureAvailable: async () => { available++; },
      execute: async (_command, action) => { executed++; return action(); },
      confirm: async () => { confirmed++; return true; },
    });
    let staged;
    router.handle("stageFile", async (params) => { staged = params.filePath; return { ok: true }; });
    let unstageRuns = 0;
    router.handle("unstageFile", async () => {
      unstageRuns++;
      return undefined;
    });
    router.handle("deleteFiles", async () => ({ deleted: true }));
    router.registerWebview(webview, "panel");

    await receive({ type: "request", id: "ok", command: "stageFile", params: { filePath: "src/file.ts" } });
    assert.equal(staged, "src/file.ts");
    assert.equal(sent.at(-1).success, true);
    assert.equal(available, 1);
    assert.equal(executed, 1);

    await receive({
      type: "request",
      id: "undefined-result",
      command: "unstageFile",
      params: { filePath: "src/file.ts" },
    });
    assert.equal(unstageRuns, 1, "undefined handler results run only once");
    assert.equal(executed, 2);

    const rejected = async (id, message, text) => {
      const before = executed;
      await receive(message);
      assert.equal(sent.at(-1).id, id);
      assert.equal(sent.at(-1).success, false, text);
      assert.equal(executed, before, text);
    };
    await rejected("cwd", { type: "request", id: "cwd", command: "stageFile", params: { filePath: "a.ts", cwd: "/tmp" } }, "injected cwd");
    await rejected("absolute", { type: "request", id: "absolute", command: "stageFile", params: { filePath: "/etc/passwd" } }, "absolute path");
    await rejected("traversal", { type: "request", id: "traversal", command: "stageFile", params: { filePath: "../outside" } }, "path traversal");
    await rejected("unknown", { type: "request", id: "unknown", command: "runAnything", params: {} }, "unknown command");
    await rejected("shape", { type: "request", id: "shape", command: "stageFile", params: { filePath: 2 } }, "wrong field type");

    router.handle('openDiffEditor', async () => ({ok:true}));
    router.handle('loadMoreLog', async () => ({ok:true}));
    await rejected('nested-path', {type:'request',id:'nested-path',command:'openDiffEditor',params:{commit:'a'.repeat(40),file:{oldPath:'',newPath:'../outside',status:'added',isBinary:false}}}, 'nested path rejected');
    await rejected('nested-extra', {type:'request',id:'nested-extra',command:'openDiffEditor',params:{commit:'a'.repeat(40),file:{oldPath:'',newPath:'one.txt',status:'added',isBinary:false,cwd:'/tmp'}}}, 'nested extra rejected');
    await rejected('snapshot', {type:'request',id:'snapshot',command:'loadMoreLog',params:{count:200,skip:0,snapshot:{activeLanes:[],laneColors:[],nextColorIndex:0,cwd:'/tmp'}}}, 'snapshot extra rejected');
    await rejected('envelope', {type:'request',id:'envelope',command:'stageFile',params:{filePath:'one.txt'},cwd:'/tmp'}, 'envelope extra rejected');
    await receive({type:'request',id:'valid-diff',command:'openDiffEditor',params:{commit:'a'.repeat(40),file:{oldPath:'',newPath:'one.txt',status:'added',isBinary:false}}});
    assert.equal(sent.at(-1).success,true);
    const conflictSent = [];
    let conflictReceive;
    const conflicts = {
      onDidReceiveMessage(handler) { conflictReceive = handler; return { dispose() {} }; },
      postMessage(message) { conflictSent.push(message); return Promise.resolve(true); },
    };
    router.registerWebview(conflicts, "conflicts");
    await conflictReceive({ type: "request", id: "surface", command: "deleteFiles", params: { filePaths: ["a.ts"] } });
    assert.equal(conflictSent.at(-1).success, false, "forbidden surface");

    await receive({ type: "request", id: "confirm", command: "deleteFiles", params: { filePaths: ["a.ts"] } });
    assert.equal(sent.at(-1).success, true);
    assert.equal(confirmed, 1, "confirmation belongs to the destructive request");

    const noConfirmSent = [];
    let noConfirmReceive;
    const noConfirmWebview = {
      onDidReceiveMessage(handler) { noConfirmReceive = handler; return { dispose() {} }; },
      postMessage(message) { noConfirmSent.push(message); return Promise.resolve(true); },
    };
    const noConfirmRouter = new MessageRouter();
    noConfirmRouter.handle("deleteFiles", async () => ({ deleted: true }));
    noConfirmRouter.registerWebview(noConfirmWebview, "panel");
    await noConfirmReceive({ type: "request", id: "bypass", command: "deleteFiles", params: { filePaths: ["a.ts"] } });
    assert.equal(noConfirmSent.at(-1).success, false, "destructive action cannot bypass host confirmation");

    let queueTail = Promise.resolve();
    let workspaceAvailable = true;
    let releaseFirst;
    let markFirstStarted;
    const firstGate = new Promise((resolve) => { releaseFirst = resolve; });
    const firstStarted = new Promise((resolve) => { markFirstStarted = resolve; });
    const queuedSent = [];
    let queuedReceive;
    const queuedWebview = {
      onDidReceiveMessage(handler) { queuedReceive = handler; return { dispose() {} }; },
      postMessage(message) { queuedSent.push(message); return Promise.resolve(true); },
    };
    const queuedRouter = new MessageRouter({
      ensureAvailable: async () => {
        if (!workspaceAvailable) throw new Error("Repository is unavailable");
      },
      execute: async (_command, action) => {
        const run = queueTail.then(action, action);
        queueTail = run.then(() => undefined, () => undefined);
        return run;
      },
      confirm: async () => true,
    });
    let queuedSecondRuns = 0;
    queuedRouter.handle("stageFile", async () => { markFirstStarted(); await firstGate; return { first: true }; });
    queuedRouter.handle("unstageFile", async () => { queuedSecondRuns++; return { second: true }; });
    const queuedRegistration = queuedRouter.registerWebview(queuedWebview, "panel");
    const firstRequest = queuedReceive({ type: "request", id: "first", command: "stageFile", params: { filePath: "a.ts" } });
    await firstStarted;
    const secondRequest = queuedReceive({ type: "request", id: "closed-queued", command: "unstageFile", params: { filePath: "a.ts" } });
    queuedRegistration.dispose();
    releaseFirst();
    await Promise.all([firstRequest, secondRequest]);
    assert.equal(queuedSecondRuns, 0, "a closed webview cannot execute a queued handler");
    assert.equal(queuedSent.at(-1).success, false, "closed queued request is rejected");

    let revokedSecondRuns = 0;
    let releaseAvailableFirst;
    let markAvailableFirstStarted;
    const availableFirstGate = new Promise((resolve) => { releaseAvailableFirst = resolve; });
    const availableFirstStarted = new Promise((resolve) => { markAvailableFirstStarted = resolve; });
    queueTail = Promise.resolve();
    workspaceAvailable = true;
    const revokedSent = [];
    let revokedReceive;
    const revokedWebview = {
      onDidReceiveMessage(handler) { revokedReceive = handler; return { dispose() {} }; },
      postMessage(message) { revokedSent.push(message); return Promise.resolve(true); },
    };
    const revokedRouter = new MessageRouter({
      ensureAvailable: async () => {
        if (!workspaceAvailable) throw new Error("Repository is unavailable");
      },
      execute: async (_command, action) => {
        const run = queueTail.then(action, action);
        queueTail = run.then(() => undefined, () => undefined);
        return run;
      },
      confirm: async () => true,
    });
    revokedRouter.handle("stageFile", async () => { markAvailableFirstStarted(); await availableFirstGate; return { first: true }; });
    revokedRouter.handle("unstageFile", async () => { revokedSecondRuns++; return { second: true }; });
    revokedRouter.registerWebview(revokedWebview, "panel");
    const availableFirstRequest = revokedReceive({ type: "request", id: "available-first", command: "stageFile", params: { filePath: "a.ts" } });
    await availableFirstStarted;
    const revokedRequest = revokedReceive({ type: "request", id: "revoked-queued", command: "unstageFile", params: { filePath: "a.ts" } });
    workspaceAvailable = false;
    releaseAvailableFirst();
    await Promise.all([availableFirstRequest, revokedRequest]);
    assert.equal(revokedSecondRuns, 0, "a revoked repository cannot execute a queued handler");
    assert.equal(revokedSent.at(-1).success, false, "revoked queued request is rejected");

    let resolveConfirmation;
    let markConfirmationStarted;
    const confirmationGate = new Promise((resolve) => { resolveConfirmation = resolve; });
    const confirmationStarted = new Promise((resolve) => { markConfirmationStarted = resolve; });
    const pendingSent = [];
    let pendingReceive;
    const pendingWebview = {
      onDidReceiveMessage(handler) { pendingReceive = handler; return { dispose() {} }; },
      postMessage(message) { pendingSent.push(message); return Promise.resolve(true); },
    };
    const pendingRouter = new MessageRouter({
      confirm: async () => { markConfirmationStarted(); return confirmationGate; },
    });
    let deletionRuns = 0;
    pendingRouter.handle("deleteFiles", async () => { deletionRuns++; return { deleted: true }; });
    const pendingRegistration = pendingRouter.registerWebview(pendingWebview, "panel");
    const pendingRequest = pendingReceive({ type: "request", id: "confirmation-close", command: "deleteFiles", params: { filePaths: ["a.ts"] } });
    await confirmationStarted;
    pendingRegistration.dispose();
    resolveConfirmation(true);
    await pendingRequest;
    assert.equal(deletionRuns, 0, "a closed webview cannot execute after confirmation");
    assert.equal(pendingSent.at(-1).success, false, "confirmation-close request is rejected");
    console.log(JSON.stringify({ positive: true, malformed: true, forbiddenSurface: true, paths: true, hostConfirmation: true, queuedLiveness: true, queuedAvailability: true, confirmationLiveness: true }));
  } finally {
    await fs.rm(temp, { recursive: true, force: true });
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
