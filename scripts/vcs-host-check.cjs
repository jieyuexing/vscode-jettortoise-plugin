/*
 * 宿主层回归：修订内容编码、CVS 更新冲突通知、运行中新签出的工作副本发现、大提交的日志历史差异。
 * 只用临时 Git 仓、:local: CVSROOT 与模拟 VS Code API，不连网络。
 */
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
const { pathToFileURL } = require("node:url");
const { build } = require("esbuild");

const git = (cwd, args) => cp.execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const disposable = () => ({ dispose() {} });
class Emitter {
  listeners = new Set();
  event = (fn) => { this.listeners.add(fn); return { dispose: () => this.listeners.delete(fn) }; };
  fire(value) { for (const fn of this.listeners) fn(value); }
  dispose() { this.listeners.clear(); }
}
class Uri {
  constructor(scheme, authority, name, query = "") { this.scheme = scheme; this.authority = authority; this.path = name; this.query = query; this.fsPath = name; }
  static file(name) { return new Uri("file", "", path.resolve(name)); }
  static from(value) { return new Uri(value.scheme, value.authority || "", value.path, value.query || ""); }
  toString() { return `${this.scheme}://${this.authority}${this.path}${this.query ? `?${this.query}` : ""}`; }
}
async function until(predicate, message) {
  const deadline = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw new Error(message);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}
// MS932 写出的「日本語の説明」；UTF-8 解码会出错位字符。
const MS932 = Buffer.from("93fa967b8cea82cc90e096be0a", "hex");
const JAPANESE = "日本語の説明\n";

async function main() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(os.tmpdir(), "jettortoise-vcs-host-")));
  let manager;
  try {
    const root = path.join(base, "workspace");
    await fs.mkdir(root);
    const repo = path.join(root, "git-a");
    await fs.mkdir(repo);
    git(repo, ["init", "-b", "main"]);
    git(repo, ["config", "user.name", "Host Fixture"]);
    git(repo, ["config", "user.email", "host@example.invalid"]);
    await fs.writeFile(path.join(repo, "legacy.txt"), MS932);
    await fs.writeFile(path.join(repo, "plain.txt"), "plain\n");
    git(repo, ["add", "."]);
    git(repo, ["commit", "-m", "base"]);
    // 一次新增 10001 个文件的提交，超过 webview 消息的 10000 条上限（GWH 浅克隆根提交有 5 万多个）。
    const bigRepo = path.join(root, "git-big");
    await fs.mkdir(path.join(bigRepo, "module"), { recursive: true });
    git(bigRepo, ["init", "-b", "main"]);
    git(bigRepo, ["config", "user.name", "Host Fixture"]);
    git(bigRepo, ["config", "user.email", "host@example.invalid"]);
    const bigFile = (index) => `module/C${String(index).padStart(5, "0")}.txt`;
    await Promise.all(Array.from({ length: 10001 }, (_, index) => fs.writeFile(path.join(bigRepo, bigFile(index)), `${index}\n`)));
    git(bigRepo, ["add", "."]);
    git(bigRepo, ["commit", "-q", "-m", "big"]);

    const watchers = [], warnings = [], commands = [], sent = [];
    const decodes = [];
    const vscode = {
      Uri, EventEmitter: Emitter, Disposable: class { constructor(fn) { this.dispose = fn; } },
      RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
      ProgressLocation: { Notification: 1, Window: 10 },
      l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index) => args[index] ?? "") },
      workspace: {
        isTrusted: true, workspaceFolders: [{ uri: Uri.file(root) }], textDocuments: [],
        getConfiguration: () => ({ get: (key, fallback) => (key === "cvsPath" ? process.env.JETTORTOISE_TEST_CVS || "cvs" : fallback) }),
        onDidChangeWorkspaceFolders: () => disposable(), onDidGrantWorkspaceTrust: () => disposable(), onDidSaveTextDocument: () => disposable(),
        createFileSystemWatcher: (pattern) => {
          const created = new Emitter();
          const watcher = { pattern, created, onDidChange: () => disposable(), onDidCreate: created.event, onDidDelete: () => disposable(), dispose() {} };
          watchers.push(watcher);
          return watcher;
        },
        // 模拟 IDE：工作文件 legacy.txt 按 MS932，其余（含修订 URI）按 UTF-8。
        decode: async (bytes, options) => {
          decodes.push(options);
          const encoding = options.encoding ?? (options.uri.scheme === "file" && options.uri.path.endsWith("legacy.txt") ? "shiftjis" : "utf8");
          return new TextDecoder(encoding === "shiftjis" ? "shift_jis" : "utf-8").decode(bytes);
        },
        encode: async (text) => new TextEncoder().encode(text),
      },
      window: {
        onDidChangeActiveTextEditor: () => disposable(), onDidChangeWindowState: () => disposable(),
        withProgress: (_options, run) => run({}, { onCancellationRequested: () => disposable() }),
        showWarningMessage: async (message, ...labels) => { warnings.push(message); return labels.find((label) => typeof label === "string"); },
        showInformationMessage: async () => undefined, showErrorMessage: async () => undefined, setStatusBarMessage: () => disposable(), activeTextEditor: undefined,
      },
      commands: { executeCommand: async (...args) => { commands.push(args); } },
    };
    global.__vcsHostVscode = vscode;
    const bundle = path.join(base, "host.cjs");
    await build({ entryPoints: ["src/repositories/manager.ts"], bundle: true, platform: "node", format: "cjs", outfile: bundle, plugins: [{ name: "fixture", setup(build) { build.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "fixture" })); build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "module.exports=global.__vcsHostVscode;" })); } }] });
    const core = await import(pathToFileURL(path.resolve("src/cvs/core.mjs")).href);
    const cvs = new core.CvsProcess(process.env.JETTORTOISE_TEST_CVS || "cvs");
    const repository = path.join(base, "cvs-repository"), seed = path.join(base, "seed"), cvsRoot = `:local:${repository}`;
    await fs.mkdir(repository); await fs.mkdir(seed);
    await cvs.run(["-d", cvsRoot, "init"], base);
    await fs.writeFile(path.join(seed, "legacy.txt"), MS932);
    await fs.writeFile(path.join(seed, "same.txt"), "base\n");
    await cvs.run(["-d", cvsRoot, "import", "-m", "base", "demo", "vendor", "start"], seed);
    const wc = await core.checkout(cvs, cvsRoot, "demo", path.join(root, "legacy"));

    const { RepositoryManager } = require(bundle);
    manager = new RepositoryManager({ extensionUri: Uri.file(process.cwd()) });
    manager.connect({ postMessage: (message) => { sent.push(message); return Promise.resolve(true); }, onDidReceiveMessage: () => disposable() });
    await manager.scan();
    await manager.execute("jettortoise.synchronizeRepository", Uri.file(wc));
    const a = manager.repositories.find((item) => item.root === repo), c = manager.repositories.find((item) => item.root === wc);
    assert.ok(a && c);

    // 1. 修订内容按工作文件的 IDE 编码解码、按修订 URI 的编码写回，左右两侧同为正确日文。
    const gitRevision = Uri.from({ scheme: "jettortoise", authority: a.id, path: "/legacy.txt", query: "ref=HEAD" });
    assert.equal(Buffer.from(await manager.readFile(gitRevision)).toString("utf8"), JAPANESE, "Git revision ignored working-file encoding");
    assert.ok(decodes.some((options) => options.uri?.toString() === Uri.file(path.join(repo, "legacy.txt")).toString()));
    await fs.writeFile(path.join(wc, "legacy.txt"), Buffer.concat([MS932, Buffer.from("added\n")]));
    await manager.request("refreshRepositories");
    await manager.request("showDiffForWorkingFile", { repositoryId: c.id, filePath: "legacy.txt", staged: false });
    const cvsBase = commands.findLast((args) => args[0] === "vscode.diff" && args[1].authority === c.id)[1];
    assert.equal(Buffer.from(await manager.readFile(cvsBase)).toString("utf8"), JAPANESE, "CVS BASE ignored working-file encoding");
    // 已打开文档的编码（例如“通过编码重新打开”）优先于 IDE 的默认判定。
    vscode.workspace.textDocuments = [{ uri: Uri.file(path.join(repo, "plain.txt")), isDirty: false, encoding: "shiftjis" }];
    await manager.readFile(Uri.from({ scheme: "jettortoise", authority: a.id, path: "/plain.txt", query: "ref=HEAD" }));
    assert.equal(decodes.at(-1).encoding, "shiftjis", "open document encoding was not preferred");
    vscode.workspace.textDocuments = [];
    await fs.writeFile(path.join(wc, "legacy.txt"), MS932);

    // 4. CVS 更新产生冲突：一条通知写明数量，点开定位到该仓的冲突分组。
    const peer = await core.checkout(cvs, cvsRoot, "demo", path.join(base, "peer"));
    await fs.writeFile(path.join(peer, "same.txt"), "colleague\n");
    await new core.CvsAdapter(peer, cvs).commit(["same.txt"], "colleague");
    await fs.writeFile(path.join(wc, "same.txt"), "mine\n");
    await manager.request("updateProject", { repositoryId: c.id });
    await until(() => sent.some((message) => message.event === "revealConflicts"), "conflict notification did not reveal conflicts");
    assert.deepEqual(warnings.filter((message) => /conflict/i.test(message)), ["Update Project: 1 file(s) have merge conflicts."]);
    assert.equal(sent.find((message) => message.event === "revealConflicts").data.repositoryId, c.id);
    assert.equal(manager.state().commitRepositoryId, c.id);
    assert.ok(commands.some((args) => args[0] === "jettortoise.commitPanel.focus"));
    const snapshot = () => manager.state().snapshots.find((item) => item.repositoryId === c.id);
    await until(() => !snapshot().refreshing && snapshot().files.some((file) => file.path === "same.txt" && file.status === "conflicted"), "conflict did not survive the network refresh");
    assert.ok(!snapshot().error, "network refresh failed on a conflicted working copy");
    assert.ok(!snapshot().files.some((file) => file.path.startsWith(".#")), "CVS conflict backup listed as unversioned");

    // 5. 运行中新签出的 CVS 与 Git 工作副本，按 CVS/Root 或 .git 出现登记，无需重开窗口。
    const created = (file) => { for (const watcher of watchers) if (typeof watcher.pattern === "string") watcher.created.fire(Uri.file(file)); };
    const freshCvs = await core.checkout(cvs, cvsRoot, "demo", path.join(root, "fresh-cvs"));
    created(path.join(freshCvs, "CVS", "Root"));
    await until(() => manager.state().unsyncedCvsCount === 1, "new CVS checkout was not discovered");
    const freshGit = path.join(root, "fresh-git");
    await fs.mkdir(freshGit); git(freshGit, ["init", "-b", "main"]);
    created(path.join(freshGit, ".git"));
    await until(() => manager.repositories.some((item) => item.root === freshGit), "new Git repository was not discovered");
    // 6. 日志历史差异：webview 只传所选文件，宿主自己列出提交的文件供上一个／下一个导航。
    const big = manager.repositories.find((item) => item.root === bigRepo);
    const bigCommit = git(bigRepo, ["rev-parse", "HEAD"]);
    await manager.request("selectRepository", { repositoryId: big.id, surface: "log" });
    await manager.request("openDiffEditor", { repositoryId: big.id, commit: bigCommit, filePath: bigFile(5), file: { oldPath: "", newPath: bigFile(5), status: "added", isBinary: false } });
    const historyDiff = () => commands.findLast((args) => args[0] === "vscode.diff" && args[2].authority === big.id);
    assert.equal(historyDiff()[2].toString(), `jettortoise://${big.id}/${bigFile(5)}?ref=${bigCommit}`);
    assert.equal(historyDiff()[1].toString(), `jettortoise://${big.id}/${bigFile(5)}?ref=empty`);
    await manager.execute("jettortoise.nextDiff");
    assert.equal(historyDiff()[2].path, `/${bigFile(6)}`, "next diff did not follow the commit file list");
    console.log(JSON.stringify({ revisionEncoding: true, openDocumentEncoding: true, updateConflictNotice: true, newCheckoutDiscovery: true, largeCommitHistoryDiff: true }));
  } finally {
    manager?.dispose();
    delete global.__vcsHostVscode;
    await fs.rm(base, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
