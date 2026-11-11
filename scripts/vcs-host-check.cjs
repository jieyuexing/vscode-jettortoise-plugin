/*
 * 宿主层回归：修订内容编码、CVS 更新冲突通知、运行中新签出的工作副本发现、大提交的日志历史差异。
 * 只用临时 Git 仓、:local: CVSROOT 与模拟 VS Code API，不连网络。
 */
const assert = require("node:assert/strict");
const cp = require("node:child_process");
const fs = require("node:fs/promises");
const os = require("node:os");
const path = require("node:path");
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

    // 与上游分叉的 Git 仓：远端是工作区外的本地裸仓库，writer 代表同事推送。
    const divRemote = path.join(base, "div-remote.git"), divWriter = path.join(base, "div-writer"), divRepo = path.join(root, "git-div");
    git(base, ["init", "--bare", "-b", "main", divRemote]);
    git(base, ["clone", "-q", divRemote, divWriter]);
    for (const clone of [divWriter]) { git(clone, ["config", "user.name", "Host Fixture"]); git(clone, ["config", "user.email", "host@example.invalid"]); }
    await fs.writeFile(path.join(divWriter, "tracked.txt"), "base\n");
    git(divWriter, ["add", "."]); git(divWriter, ["commit", "-q", "-m", "base"]); git(divWriter, ["push", "-q", "-u", "origin", "main"]);
    git(base, ["clone", "-q", divRemote, divRepo]);
    git(divRepo, ["config", "user.name", "Host Fixture"]); git(divRepo, ["config", "user.email", "host@example.invalid"]);
    const diverge = async (file) => {
      await fs.writeFile(path.join(divWriter, "tracked.txt"), `remote ${Date.now()}\n`);
      git(divWriter, ["commit", "-q", "-am", "remote"]); git(divWriter, ["push", "-q"]);
      await fs.writeFile(path.join(divRepo, file), `local ${Date.now()}\n`);
      git(divRepo, ["add", file]); git(divRepo, ["commit", "-q", "-m", "local"]);
    };

    // 会话使用记录 argv 的 cvs 包装，用来证明未同步仓查看历史时不运行 cvs -n update。
    const argvLog = path.join(base, "cvs-argv.jsonl"), cvsShim = path.join(base, "cvs-argv-shim");
    await fs.writeFile(cvsShim, `#!${process.execPath}\nconst fs=require("node:fs"),cp=require("node:child_process");const args=process.argv.slice(2);fs.appendFileSync(${JSON.stringify(argvLog)},JSON.stringify(args)+"\\n");const r=cp.spawnSync(${JSON.stringify(process.env.JETTORTOISE_TEST_CVS || "cvs")},args,{stdio:"inherit"});process.exit(r.status??1);\n`, { mode: 0o755 });
    const argvCalls = async () => (await fs.readFile(argvLog, "utf8").catch(() => "")).split("\n").filter(Boolean).map((line) => JSON.parse(line));
    const watchers = [], warnings = [], infos = [], commands = [], sent = [];
    const decodes = [], editorListeners = [];
    const vscode = {
      Uri, EventEmitter: Emitter, Disposable: class { constructor(fn) { this.dispose = fn; } },
      RelativePattern: class { constructor(base, pattern) { this.base = base; this.pattern = pattern; } },
      ProgressLocation: { Notification: 1, Window: 10 },
      l10n: { t: (message, ...args) => message.replace(/\{(\d+)\}/g, (_, index) => args[index] ?? "") },
      workspace: {
        isTrusted: true, workspaceFolders: [{ uri: Uri.file(root) }], textDocuments: [],
        getConfiguration: () => ({ get: (key, fallback) => (key === "cvsPath" ? cvsShim : fallback) }),
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
        onDidChangeActiveTextEditor: (listener) => { editorListeners.push(listener); return disposable(); }, onDidChangeWindowState: () => disposable(),
        withProgress: (_options, run) => run({ report() {} }, { onCancellationRequested: () => disposable() }),
        showWarningMessage: async (message, ...labels) => { warnings.push(message); return labels.find((label) => typeof label === "string"); },
        showInformationMessage: async (message) => { infos.push(message); return undefined; }, showErrorMessage: async () => undefined, setStatusBarMessage: () => disposable(), activeTextEditor: undefined,
      },
      commands: { executeCommand: async (...args) => { commands.push(args); } },
    };
    global.__vcsHostVscode = vscode;
    const bundle = path.join(base, "host.cjs");
    await build({ entryPoints: ["src/repositories/manager.ts"], bundle: true, platform: "node", format: "cjs", outfile: bundle, plugins: [{ name: "fixture", setup(build) { build.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "fixture" })); build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: "module.exports=global.__vcsHostVscode;" })); } }] });
    const core = await import("tortoise-core/cvs");
    const cvs = new core.CvsProcess(process.env.JETTORTOISE_TEST_CVS || "cvs");
    const repository = path.join(base, "cvs-repository"), seed = path.join(base, "seed"), cvsRoot = `:local:${repository}`;
    await fs.mkdir(repository); await fs.mkdir(seed);
    await cvs.run(["-d", cvsRoot, "init"], base);
    await fs.writeFile(path.join(seed, "legacy.txt"), MS932);
    await fs.writeFile(path.join(seed, "same.txt"), "base\n");
    const rollbackNames = ["r1.txt", "r2.txt", "r3.txt", "r4.txt"];
    for (const name of rollbackNames) await fs.writeFile(path.join(seed, name), "base\n");
    await cvs.run(["-d", cvsRoot, "import", "-m", "base", "demo", "vendor", "start"], seed);
    const wc = await core.checkout(cvs, cvsRoot, "demo", path.join(root, "legacy"));

    const { RepositoryManager } = require(bundle);

    // 00. 仓库日志与缓存（宿主）：独立的 :local: 仓库与工作区，工作副本不更新，同事新建了目录。
    //     日志取自服务器端 rlog（不依赖本地目录），修订内容取自 checkout -p；缓存落盘，新会话（重启）命中；
    //     argv 记录证明只有 rlog 与 checkout -p，没有 update、没有 -n、没有 log。
    {
      const logBase = path.join(base, "log-case"), logRepo = path.join(logBase, "repository"), logRoot = path.join(logBase, "workspace"), logSeed = path.join(logBase, "seed"), storage = path.join(logBase, "storage", "cvs-cache");
      await fs.mkdir(logRepo, { recursive: true }); await fs.mkdir(logRoot); await fs.mkdir(path.join(logSeed, "src"), { recursive: true });
      const logCvsRoot = `:local:${logRepo}`;
      await cvs.run(["-d", logCvsRoot, "init"], logBase);
      await fs.writeFile(path.join(logSeed, "src", "Main.txt"), "v1\n"); await fs.writeFile(path.join(logSeed, "src", "Util.txt"), "v1\n");
      await cvs.run(["-d", logCvsRoot, "import", "-m", "sample import", "sample", "vendor", "start"], logSeed);
      const logWc = await core.checkout(cvs, logCvsRoot, "sample", path.join(logRoot, "wc"));
      const colleagueWc = await core.checkout(cvs, logCvsRoot, "sample", path.join(logBase, "colleague")), colleague = new core.CvsAdapter(colleagueWc, cvs);
      const pause = () => new Promise((resolve) => setTimeout(resolve, 1100));
      // 修订时间只到秒：提交之间停一下，保证与导入、前一次提交不在同一秒，列表顺序才确定。
      await pause();
      await fs.writeFile(path.join(colleagueWc, "src", "Main.txt"), "v2\n"); await fs.writeFile(path.join(colleagueWc, "src", "Util.txt"), "v2\n");
      await colleague.commit(["src/Main.txt", "src/Util.txt"], "colleague: update two files");
      await pause();
      await fs.writeFile(path.join(colleagueWc, "src", "Added.txt"), "new file\n"); await colleague.add(["src/Added.txt"]); await colleague.commit(["src/Added.txt"], "colleague: add file");
      await pause();
      // 新建多层目录：本地工作副本没有，也不在 CVS/Entries 里。
      await fs.mkdir(path.join(colleagueWc, "lib", "deep"), { recursive: true }); await colleague.add(["lib", "lib/deep"]);
      await fs.writeFile(path.join(colleagueWc, "lib", "Top.txt"), "top\n"); await fs.writeFile(path.join(colleagueWc, "lib", "deep", "New.txt"), "deep new\n");
      await colleague.add(["lib/Top.txt", "lib/deep/New.txt"]); await colleague.commit(["lib/Top.txt", "lib/deep/New.txt"], "colleague: new directories");

      vscode.workspace.workspaceFolders = [{ uri: Uri.file(logRoot) }];
      const { RepositoryManager: LogManager } = require(bundle);
      const context = () => ({ extensionUri: Uri.file(process.cwd()), globalStorageUri: Uri.file(path.dirname(storage)) });
      const opened = [];
      const open = async () => {
        const logManager = new LogManager(context());
        logManager.connect({ postMessage: () => Promise.resolve(true), onDidReceiveMessage: () => disposable() });
        await logManager.scan();
        const repository = logManager.state().logRepositories.find((item) => item.root === logWc);
        assert.ok(repository, "unsynchronized CVS repository missing from the log");
        await logManager.request("selectRepository", { repositoryId: repository.id, surface: "log" });
        opened.push(logManager);
        return { logManager, repository, request: (command, params = {}) => logManager.request(command, { repositoryId: repository.id, ...params }) };
      };
      const newCalls = async (from) => (await argvCalls()).slice(from);
      const server = (args) => args[3]; // -f -d <root> <command> …
      const stored = async () => (await fs.readdir(storage)).filter((name) => /^log-.*\.json$/.test(name));
      await fs.writeFile(argvLog, "");

      // 1. 第一次打开：缓存为空 → 只读缓存不连服务器；再取一次 rlog（近 90 天），覆盖本地没有的目录。
      let session = await open();
      assert.deepEqual(await session.request("getCvsLog", { days: 90, cached: true }), { days: 90, cachedAt: undefined, fromCache: true, error: undefined, commits: [] });
      assert.deepEqual(await argvCalls(), [], "reading the cache contacted CVS");
      const first = await session.request("getCvsLog", { days: 90 });
      assert.deepEqual(first.commits.map((commit) => [commit.subject, commit.fileCount]), [["colleague: new directories", 2], ["colleague: add file", 1], ["colleague: update two files", 2], ["sample import", 2]]);
      assert.equal(first.fromCache, false);
      const opening = await newCalls(0);
      assert.equal(opening.length, 1, `opening the log ran ${JSON.stringify(opening)}`);
      assert.deepEqual([opening[0].slice(0, 2), server(opening[0]), opening[0].slice(4, 8), opening[0].at(-1)], [["-f", "-d"], "rlog", ["-N", "-S", "-d"].concat(opening[0][7]), "sample"]);
      assert.match(opening[0][7], /^>=\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \+0000$/);
      assert.equal((await stored()).length, 1, "the log was not written to disk");

      // 2. 提交文件：新建目录里的文件本地没有（标记），已有目录里的文件有。
      const [newDirectories, added, updated] = first.commits;
      const markers = async (commit) => Object.fromEntries((await session.request("getCvsCommit", { commitId: commit.id })).map((file) => [file.path, file.local]));
      assert.deepEqual(await markers(newDirectories), { "lib/Top.txt": false, "lib/deep/New.txt": false });
      assert.deepEqual(await markers(added), { "src/Added.txt": false });
      assert.deepEqual(await markers(updated), { "src/Main.txt": true, "src/Util.txt": true });
      assert.deepEqual(await session.request("getCvsCommit", { commitId: updated.id }), [
        { path: "src/Main.txt", revision: "1.2", previous: "1.1", kind: "modified", local: true },
        { path: "src/Util.txt", revision: "1.2", previous: "1.1", kind: "modified", local: true },
      ]);
      await assert.rejects(session.request("getCvsCommit", { commitId: "unknown" }), /Unknown commit/);

      // 3. 同窗口再次打开、回到较小范围、切换编辑器：0 次连接。
      await session.request("getCvsLog", { days: 90 });
      assert.equal((await session.request("getCvsLog", { days: 30, cached: true })).commits.length, 4);
      for (const file of ["Main.txt", "Util.txt"]) {
        for (const listener of editorListeners) listener({ document: { uri: Uri.file(path.join(logWc, "src", file)) } });
        await until(() => session.logManager.state().activeFile === `src/${file}`, `editor switch to ${file} was not followed`);
      }
      assert.equal((await newCalls(0)).length, 1, "a repeated open or an editor switch contacted CVS");

      // 4. 看差异：本地没有目录的文件，取自服务器（rlog + checkout -p），第二次看同一修订 0 次调用。
      const before = (await argvCalls()).length;
      await session.request("diffCvsRevision", { filePath: "lib/deep/New.txt", revision: "1.1" });
      const newDiff = commands.findLast((args) => args[0] === "vscode.diff");
      assert.deepEqual([newDiff[1].query, newDiff[2].query], ["ref=empty", "ref=1.1"]);
      assert.equal(Buffer.from(await session.logManager.readFile(newDiff[2])).toString("utf8"), "deep new\n");
      const diffCalls = (await newCalls(before)).map((args) => server(args));
      assert.ok(diffCalls.includes("rlog") && diffCalls.includes("checkout"), JSON.stringify(diffCalls));
      const reading = (await argvCalls()).length;
      assert.equal(Buffer.from(await session.logManager.readFile(newDiff[2])).toString("utf8"), "deep new\n");
      assert.equal((await argvCalls()).length, reading, "the same revision was read from CVS twice");
      await assert.rejects(fs.access(path.join(logWc, "lib")), "viewing the log created local directories");

      // 5. 重启（新会话）：命中落盘缓存，不连服务器；修订内容也来自磁盘。
      session.logManager.dispose();
      const reopenedFrom = (await argvCalls()).length;
      session = await open();
      const warm = await session.request("getCvsLog", { days: 90, cached: true });
      assert.deepEqual([warm.fromCache, warm.commits.length, typeof warm.cachedAt], [true, 4, "number"]);
      assert.deepEqual(await session.request("getCvsLog", { days: 90 }).then((result) => [result.fromCache, result.commits.length]), [true, 4], "a fresh cache after a restart must not contact CVS");
      await session.request("diffCvsRevision", { filePath: "lib/deep/New.txt", revision: "1.1" });
      const restartedDiff = commands.findLast((args) => args[0] === "vscode.diff");
      assert.equal(Buffer.from(await session.logManager.readFile(restartedDiff[2])).toString("utf8"), "deep new\n");
      assert.deepEqual((await newCalls(reopenedFrom)).filter((args) => server(args) === "checkout"), [], "revision content was fetched again after a restart");

      // 6. 单文件历史：仓库缓存没有覆盖全部历史时取一次并按文件缓存；点刷新或本地 Entries 修订号变了才重取。
      const historyFrom = (await argvCalls()).length;
      const history = await session.request("getCvsHistory", { filePath: "src/Main.txt" });
      assert.deepEqual(history.map((item) => item.revisionId).sort(), ["1.1", "1.1.1.1", "1.2"]);
      assert.equal((await newCalls(historyFrom)).length, 1);
      await session.request("getCvsHistory", { filePath: "src/Main.txt" });
      assert.equal((await newCalls(historyFrom)).length, 1, "a cached file history contacted CVS again");
      await session.request("getCvsHistory", { filePath: "src/Main.txt", refresh: true });
      assert.equal((await newCalls(historyFrom)).length, 2, "refresh must fetch the file history again");
      const entriesFile = path.join(logWc, "src", "CVS", "Entries");
      await fs.writeFile(entriesFile, (await fs.readFile(entriesFile, "utf8")).replace("/Main.txt/1.1.1.1/", "/Main.txt/1.2/"));
      await session.request("getCvsHistory", { filePath: "src/Main.txt" });
      assert.equal((await newCalls(historyFrom)).length, 3, "a changed Entries revision must refetch the file history");
      await fs.writeFile(entriesFile, (await fs.readFile(entriesFile, "utf8")).replace("/Main.txt/1.2/", "/Main.txt/1.1.1.1/"));

      // 7. 过了新鲜期：只发一条带 -d ">=T" 的增量（T = 最新缓存时间往回 5 分钟），新提交合并进来，不重复。
      session.logManager.dispose();
      const staleFile = path.join(storage, (await stored())[0]);
      const diskState = JSON.parse(await fs.readFile(staleFile, "utf8"));
      diskState.fetchedAt -= 10 * 60 * 1000;
      await fs.writeFile(staleFile, JSON.stringify(diskState));
      await pause();
      await fs.writeFile(path.join(colleagueWc, "src", "Main.txt"), "v3\n"); await colleague.commit(["src/Main.txt"], "colleague: later edit");
      const incrementalFrom = (await argvCalls()).length;
      session = await open();
      const incremental = await session.request("getCvsLog", { days: 90 });
      const incrementalCalls = await newCalls(incrementalFrom);
      assert.equal(incrementalCalls.length, 1, JSON.stringify(incrementalCalls));
      assert.equal(server(incrementalCalls[0]), "rlog");
      assert.equal(incrementalCalls[0][7], `>=${new Date(diskState.newest - 5 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19)} +0000`);
      assert.deepEqual(incremental.commits.map((commit) => commit.subject), ["colleague: later edit", "colleague: new directories", "colleague: add file", "colleague: update two files", "sample import"]);
      assert.equal(incremental.fromCache, false);

      // 8. 点刷新强制增量（不再整段重取）；提交或更新之后只标记过期，缓存保留，下次走增量。
      const refreshFrom = (await argvCalls()).length;
      await session.request("getCvsLog", { days: 90, refresh: true });
      const refreshCalls = await newCalls(refreshFrom);
      assert.equal(refreshCalls.length, 1);
      assert.equal(refreshCalls[0][7].startsWith(">="), true);
      const newest = JSON.parse(await fs.readFile(staleFile, "utf8")).newest;
      assert.equal(refreshCalls[0][7], `>=${new Date(newest - 5 * 60 * 1000).toISOString().replace("T", " ").slice(0, 19)} +0000`, "refresh must be incremental from the newest cached time");
      const writtenFrom = (await argvCalls()).length;
      session.logManager.written(session.logManager.entries.get(session.repository.id));
      const afterWrite = await session.request("getCvsLog", { days: 90 });
      assert.equal(afterWrite.commits.length, 5, "a write must not discard the cache");
      assert.equal((await newCalls(writtenFrom)).length, 1, "after a write the next open is one incremental fetch");

      // 9. 更早的范围与「全部」：只取尚未覆盖的一段并记进缓存；「全部」之后单文件历史直接来自仓库缓存。
      const rangeFrom = (await argvCalls()).length;
      await session.request("getCvsLog", { days: 0 });
      const rangeCalls = await newCalls(rangeFrom);
      assert.equal(rangeCalls.length, 1);
      assert.match(rangeCalls[0][7], /^<=/);
      assert.equal(JSON.parse(await fs.readFile(staleFile, "utf8")).coveredFrom, 0);
      const derivedFrom = (await argvCalls()).length;
      assert.deepEqual((await session.request("getCvsHistory", { filePath: "src/Util.txt" })).map((item) => item.revisionId).sort(), ["1.1", "1.1.1.1", "1.2"]);
      assert.equal((await newCalls(derivedFrom)).length, 0, "the repository cache covers the whole history of the file");

      // 10. 版本不符或损坏：丢掉重取（整段，不是增量）；清除命令：删光缓存，下次整段重取。
      for (const text of ["{broken", JSON.stringify({ ...diskState, version: 99 })]) {
        session.logManager.dispose();
        await fs.writeFile(staleFile, text);
        session = await open();
        assert.equal((await session.request("getCvsLog", { days: 90, cached: true })).commits.length, 0, "an unreadable cache must read as empty");
        const recoverFrom = (await argvCalls()).length;
        assert.equal((await session.request("getCvsLog", { days: 90 })).commits.length, 5);
        const recover = await newCalls(recoverFrom);
        assert.equal(recover.length, 1);
        assert.match(recover[0][7], /^>=/);
        assert.equal(JSON.parse(await fs.readFile(staleFile, "utf8")).version, 1, "the cache was not rewritten after recovery");
      }
      await session.logManager.execute("jettortoise.clearCvsLogCache");
      await assert.rejects(fs.access(storage), "the clear command left the cache behind");
      const clearedFrom = (await argvCalls()).length;
      assert.equal((await session.request("getCvsLog", { days: 90 })).commits.length, 5);
      assert.equal((await newCalls(clearedFrom)).length, 1);

      // 全程：只有服务器端 rlog 与 checkout -p；没有 update、没有 -n、没有 log。
      const all = await argvCalls();
      assert.ok(all.every((args) => ["rlog", "checkout"].includes(server(args))), `unexpected CVS commands: ${JSON.stringify(all.map((args) => args.slice(0, 4)))}`);
      assert.ok(all.filter((args) => server(args) === "checkout").every((args) => args[4] === "-p" && args[5] === "-r"));
      assert.ok(!all.some((args) => args.includes("-n") || args.includes("update")));
      assert.equal(session.logManager.state().snapshots.length, 0);
      console.log(JSON.stringify({ repositoryLogArgv: all.map((args) => [args[3], ...(args[3] === "rlog" ? args.slice(4, 8) : args.slice(4, 8))]) }));
      for (const item of opened) item.dispose();
      vscode.workspace.workspaceFolders = [{ uri: Uri.file(root) }];
      await fs.writeFile(argvLog, "");
    }


    manager = new RepositoryManager({ extensionUri: Uri.file(process.cwd()) });
    manager.connect({ postMessage: (message) => { sent.push(message); return Promise.resolve(true); }, onDidReceiveMessage: () => disposable() });

    await manager.scan();

    // 0. 未同步的 CVS 也列入日志：文件清单只读 Entries，查看文件历史与修订差异才运行服务器端 rlog／checkout -p，
    //    不运行 cvs -n update，也不进入本地更改。
    const unsynced = manager.state().logRepositories.find((item) => item.root === wc);
    assert.ok(unsynced, "unsynced CVS repository missing from the log");
    assert.ok(!manager.repositories.some((item) => item.root === wc), "unsynced CVS repository entered local changes");
    await manager.request("selectRepository", { repositoryId: unsynced.id, surface: "log" });
    assert.deepEqual(await manager.request("getCvsFiles", { repositoryId: unsynced.id }), ["legacy.txt", "r1.txt", "r2.txt", "r3.txt", "r4.txt", "same.txt"]);
    assert.deepEqual(await argvCalls(), [], "listing CVS files ran a CVS command");
    const unsyncedHistory = await manager.request("getCvsHistory", { repositoryId: unsynced.id, filePath: "same.txt" });
    assert.deepEqual(unsyncedHistory.map((item) => item.revisionId).sort(), ["1.1", "1.1.1.1"]);
    await manager.request("diffCvsRevision", { repositoryId: unsynced.id, filePath: "same.txt", revision: "1.1.1.1" });
    const unsyncedDiff = commands.findLast((args) => args[0] === "vscode.diff");
    assert.deepEqual([unsyncedDiff[1].query, unsyncedDiff[2].query], ["ref=1.1", "ref=1.1.1.1"]);
    for (const side of [unsyncedDiff[1], unsyncedDiff[2]])
      assert.equal(Buffer.from(await manager.readFile(side)).toString("utf8"), "base\n", `revision ${side.query} unreadable`);
    const viewing = await argvCalls();
    assert.ok(viewing.length > 0 && viewing.every((args) => args[0] === "-f" && args[1] === "-d" && (args[3] === "rlog" || (args[3] === "checkout" && args[4] === "-p"))), `unexpected CVS commands: ${JSON.stringify(viewing)}`);
    assert.ok(!viewing.some((args) => args.includes("-n")), "viewing history ran cvs -n update");
    assert.equal(manager.state().snapshots.some((item) => item.repositoryId === unsynced.id), false, "history published a local-changes snapshot");
    assert.equal(manager.state().unsyncedCvsCount, 1);
    console.log(JSON.stringify({ unsyncedLogArgv: viewing }));

    await manager.execute("jettortoise.synchronizeRepository", Uri.file(wc));
    const a = manager.repositories.find((item) => item.root === repo), c = manager.repositories.find((item) => item.root === wc);
    assert.ok(a && c);
    // 对照：同步后才出现 cvs -n update，证明上面的 argv 记录能捉到它。
    await until(async () => (await argvCalls()).some((args) => args.includes("-n") && args.includes("update")), "synchronization did not run cvs -n update");

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
    // 7. 分叉时更新项目：通知写明两侧提交数并给出合并／变基，选合并（模拟返回第一个动作）即合并上游。
    const div = manager.repositories.find((item) => item.root === divRepo);
    await diverge("local.txt");
    await manager.request("updateProject", { repositoryId: div.id });
    assert.ok(warnings.includes("Cannot fast-forward: the current branch has 1 local commit(s) and origin/main has 1 new commit(s). Merge or rebase to update."));
    const parents = () => git(divRepo, ["rev-list", "--parents", "-n", "1", "HEAD"]).trim().split(" ").length;
    await until(() => parents() === 3, "diverged update did not merge after choosing Merge");
    // 8. 合并有冲突：沿用冲突通知；标记已解决后，提交区说明留空按所选文件提交，生成 Git 默认合并说明。
    warnings.length = 0;
    await diverge("tracked.txt");
    await manager.request("updateProject", { repositoryId: div.id });
    await until(() => warnings.includes("Update Project: 1 file(s) have merge conflicts."), "merge conflict was not reported");
    await fs.writeFile(path.join(divRepo, "tracked.txt"), "resolved\n");
    git(divRepo, ["add", "tracked.txt"]);
    await manager.request("refreshRepositories");
    await manager.request("commitRepositories", { message: "", files: [{ repositoryId: div.id, path: "tracked.txt" }] });
    assert.match(git(divRepo, ["log", "-1", "--format=%B"]), /^Merge remote-tracking branch 'origin\/main'/);
    assert.equal(parents(), 3);
    // 不在合并中时空说明仍被拒绝。
    await fs.writeFile(path.join(repo, "plain.txt"), "edited\n");
    await manager.request("refreshRepositories");
    await assert.rejects(() => manager.request("commitRepositories", { message: "", files: [{ repositoryId: a.id, path: "plain.txt" }] }), /commit message/);
    await fs.writeFile(path.join(repo, "plain.txt"), "plain\n");
    // 9. 解决结果与本地相同：快照标记合并进行中、更改为空，不选文件也能提交完成合并。
    await diverge("tracked.txt");
    const mine = await fs.readFile(path.join(divRepo, "tracked.txt"));
    await manager.request("updateProject", { repositoryId: div.id });
    const divSnapshot = () => manager.state().snapshots.find((item) => item.repositoryId === div.id);
    await until(() => divSnapshot().merging, "merge state was not published");
    await fs.writeFile(path.join(divRepo, "tracked.txt"), mine);
    git(divRepo, ["add", "tracked.txt"]);
    await manager.request("refreshRepositories");
    assert.deepEqual(divSnapshot().files, []);
    assert.equal(divSnapshot().merging, true);
    await assert.rejects(() => manager.request("commitRepositories", { message: "", files: [{ repositoryId: div.id, path: "tracked.txt" }] }), /cannot be committed/);
    await manager.request("commitRepositories", { repositoryId: div.id, message: "", files: [] });
    assert.equal(parents(), 3);
    assert.match(git(divRepo, ["log", "-1", "--format=%B"]), /^Merge remote-tracking branch 'origin\/main'/);
    await until(() => !divSnapshot().merging, "merge state was not cleared");
    await assert.rejects(() => manager.request("commitRepositories", { repositoryId: a.id, message: "x", files: [] }), /Select changed files/);
    // 10. 单击预览按工作文件的 IDE 编码解码（与编辑器同一来源），MS932 两侧都不乱码。
    await fs.writeFile(path.join(repo, "legacy.txt"), Buffer.concat([MS932, Buffer.from("added\n")]));
    await fs.writeFile(path.join(wc, "legacy.txt"), Buffer.concat([MS932, Buffer.from("added\n")]));
    await manager.request("refreshRepositories");
    for (const id of [a.id, c.id]) {
      const preview = await manager.request("getWorkingFilePreview", { repositoryId: id, filePath: "legacy.txt", staged: false });
      assert.equal(preview.leftContent.text, JAPANESE, "preview base side is not decoded with the working-file encoding");
      assert.equal(preview.rightContent.text, `${JAPANESE}added\n`, "preview working side is not decoded with the working-file encoding");
    }
    await fs.writeFile(path.join(repo, "legacy.txt"), MS932);
    await fs.writeFile(path.join(wc, "legacy.txt"), MS932);
    // 11. 大批量：一次提交与回滚超过 10000 个文件（旧上限为提交 2000、回滚 10000）。
    const bigNames = Array.from({ length: 10001 }, (_, index) => bigFile(index));
    await Promise.all(bigNames.map((name) => fs.writeFile(path.join(bigRepo, name), "changed\n")));
    await manager.request("refreshRepositories");
    let started = Date.now();
    await manager.request("commitRepositories", { message: "bulk", files: bigNames.map((name) => ({ repositoryId: big.id, path: name })) });
    const bulkCommitMs = Date.now() - started;
    assert.equal(git(bigRepo, ["show", "--name-only", "--format=", "HEAD"]).split("\n").length, 10001);
    await Promise.all(bigNames.map((name) => fs.writeFile(path.join(bigRepo, name), "again\n")));
    await manager.request("refreshRepositories");
    started = Date.now();
    await manager.request("rollbackFiles", { repositoryId: big.id, filePaths: bigNames });
    const bulkRollbackMs = Date.now() - started;
    assert.equal(git(bigRepo, ["status", "--porcelain"]), "");
    console.log(JSON.stringify({ benchmark: "managerBulk", files: 10001, bulkCommitMs, bulkRollbackMs }));
    // 12. CVS 回滚：确认后面板请求立即返回，回滚在通知进度里完成；完成通知最多列三个备份名，其余只写数量。
    for (const name of rollbackNames) await fs.writeFile(path.join(wc, name), "changed\n");
    await manager.request("refreshRepositories");
    const rollbackNotice = () => infos.findLast((message) => message.startsWith("CVS rollback completed"));
    await manager.request("openRollbackPanel", { repositoryId: c.id, files: rollbackNames.map((name) => ({ path: name, status: "modified", staged: false })) });
    assert.equal(rollbackNotice(), undefined, "rollback request waited for the whole rollback");
    await until(rollbackNotice, "rollback did not complete in the background");
    assert.match(rollbackNotice(), /^CVS rollback completed\. Backups: \.#r1\.txt\.1\.1\.1\.1, \.#r2\.txt\.1\.1\.1\.1, \.#r3\.txt\.1\.1\.1\.1 and 1 more$/);
    for (const name of rollbackNames) assert.equal(await fs.readFile(path.join(wc, name), "utf8"), "base\n");
    await until(() => !snapshot().files.some((file) => file.path.startsWith("r") || file.path.startsWith(".#")), "rolled back files or .# backups still listed");
    // 13. 修改已推送的上次提交后推送：推送面板得知须强制，强制推送与提交并推送都由宿主确认一次并写明被替换的提交。
    git(divRepo, ["reset", "-q", "--hard", "origin/main"]);
    await fs.writeFile(path.join(divRepo, "amend.txt"), "first\n");
    git(divRepo, ["add", "amend.txt"]); git(divRepo, ["commit", "-q", "-m", "to amend"]); git(divRepo, ["push", "-q", "origin", "main"]);
    const pushed = git(divRepo, ["rev-parse", "HEAD"]);
    const remoteHead = () => git(divRemote, ["rev-parse", "main"]);
    const pushParams = { repositoryId: div.id, branchName: "main", remote: "origin" };
    assert.equal((await manager.request("getAheadCommits", pushParams)).amended, undefined, "pushed commit reported as amended");
    await fs.writeFile(path.join(divRepo, "amend.txt"), "second\n");
    await manager.request("refreshRepositories");
    await manager.request("commitRepositories", { message: "amended", amend: true, files: [{ repositoryId: div.id, path: "amend.txt" }] });
    assert.equal((await manager.request("getAheadCommits", pushParams)).amended, pushed, "amended pushed commit not detected");
    warnings.length = 0;
    await manager.request("executePush", { ...pushParams, targetBranch: "main", force: true });
    assert.deepEqual(warnings, [`Force push "main" to "origin/main"? The amended commit replaces ${pushed.slice(0, 8)} on the remote; if the remote has changed since your last fetch, the push is refused.`]);
    assert.equal(remoteHead(), git(divRepo, ["rev-parse", "HEAD"]));
    // 旧入口 commitAndPush：修改已推送提交时同样只确认一次；取消则只保留本地提交，远端不变。
    const confirmPush = vscode.window.showWarningMessage;
    vscode.window.showWarningMessage = async (message) => { warnings.push(message); return undefined; };
    warnings.length = 0;
    const before = remoteHead();
    await fs.writeFile(path.join(divRepo, "amend.txt"), "third\n");
    assert.deepEqual(await manager.request("commitAndPush", { repositoryId: div.id, message: "amended again", amend: true, filePaths: ["amend.txt"] }), { success: false, cancelled: true });
    assert.equal(warnings.length, 1, "amend push was not confirmed exactly once");
    assert.match(warnings[0], new RegExp(`replaces ${before.slice(0, 8)} on the remote`));
    assert.equal(remoteHead(), before, "declined force push still pushed");
    assert.equal(git(divRepo, ["log", "-1", "--format=%s"]), "amended again");
    vscode.window.showWarningMessage = confirmPush;
    // 普通提交并推送不确认、不强制。
    warnings.length = 0;
    git(divRepo, ["push", "-q", "--force", "origin", "main"]);
    await fs.writeFile(path.join(divRepo, "amend.txt"), "fourth\n");
    await manager.request("commitAndPush", { repositoryId: div.id, message: "plain", filePaths: ["amend.txt"] });
    assert.deepEqual(warnings, []);
    assert.equal(remoteHead(), git(divRepo, ["rev-parse", "HEAD"]));
    console.log(JSON.stringify({ revisionEncoding: true, openDocumentEncoding: true, updateConflictNotice: true, newCheckoutDiscovery: true, largeCommitHistoryDiff: true, divergedUpdate: true, mergeCommitDefaultMessage: true, mergeCommitWithoutFiles: true, previewEncoding: true, bulkCommitRollback: true, rollbackInBackground: true, rollbackNoticeBounded: true, amendForcePushConfirmed: true }));
  } finally {
    manager?.dispose();
    delete global.__vcsHostVscode;
    await fs.rm(base, { recursive: true, force: true });
  }
}
main().catch((error) => { console.error(error); process.exitCode = 1; });
