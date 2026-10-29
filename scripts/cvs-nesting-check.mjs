import assert from "node:assert/strict";
import { execFile as execFileCallback } from "node:child_process";
import * as fs from "node:fs/promises";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import test from "node:test";
import { build } from "esbuild";
import {
  assertNoNestedRepositories,
  isCvsContinuation,
  listNestedRepositories,
  nearestRepositories,
} from "../src/repositories/boundaries.cjs";
import {
  CvsAdapter,
  CvsProcess,
  SerialQueue,
  checkout,
  findWorkingCopy,
  parseStatus,
  parseUpdateStatus,
} from "../src/cvs/core.mjs";

const execFile = promisify(execFileCallback);
const cvsExecutable = process.env.JETTORTOISE_TEST_CVS || "/opt/homebrew/bin/cvs";

async function metadata(directory, repository, entries = "") {
  await fs.mkdir(path.join(directory, "CVS"), { recursive: true });
  for (const [name, content] of Object.entries({
    Root: ":local:/synthetic-repository\n",
    Repository: `${repository}\n`,
    Entries: entries,
  })) await fs.writeFile(path.join(directory, "CVS", name), content);
}

test("Entries.Log A directory continues its parent checkout", async () => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "cvs-log-add-"));
  try {
    await metadata(base, "demo");
    await metadata(path.join(base, "x"), "demo/x", "/child.txt/1.1///\n");
    await fs.writeFile(path.join(base, "x", "child.txt"), "child\n");
    await fs.writeFile(path.join(base, "CVS", "Entries.Log"), "A D/x////\n");
    assert.equal(await isCvsContinuation(base, path.join(base, "x")), true);
    assert.deepEqual(await listNestedRepositories(base, "cvs"), []);
    assert.deepEqual((await new CvsAdapter(base).inventory()).map(f => f.newPath), ["x/child.txt"]);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("Entries.Log merges file replacements and R records in order", async () => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "cvs-log-remove-"));
  try {
    await metadata(base, "demo", "D/x////\n/removed.txt/1.1///\n/changed.txt/1.1///\n");
    await metadata(path.join(base, "x"), "demo/x");
    await fs.writeFile(path.join(base, "changed.txt"), "changed\n");
    await fs.writeFile(path.join(base, "added.txt"), "added\n");
    await fs.writeFile(path.join(base, "CVS", "Entries.Log"),
      "R D/x////\nR /removed.txt/1.1///\nA /changed.txt/1.2///\nA /added.txt/0///\nR /added.txt/0///\nA /added.txt/0///\n");
    assert.equal(await isCvsContinuation(base, path.join(base, "x")), false);
    assert.deepEqual((await new CvsAdapter(base).inventory()).map(f => [f.newPath, f.entryRevision]),
      [["added.txt", "0"], ["changed.txt", "1.2"]]);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("Entries.Log inventory works without rewriting metadata", async () => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "cvs-log-files-"));
  try {
    await metadata(base, "demo", "/removed.txt/1.1///\n");
    const log = "R /removed.txt/1.1///\nA /added.txt/0///\n";
    await fs.writeFile(path.join(base, "added.txt"), "added\n");
    await fs.writeFile(path.join(base, "CVS", "Entries.Log"), log);
    assert.deepEqual((await new CvsAdapter(base).inventory()).map(f => f.newPath), ["added.txt"]);
    assert.equal(await fs.readFile(path.join(base, "CVS", "Entries.Log"), "utf8"), log);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("inventory accepts more than 3000 file records", async () => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "cvs-large-files-"));
  try {
    // 跟踪文件暂时缺失时仍应列入清单，覆盖中断检出的形态。
    await metadata(base, "demo", Array.from({ length: 3089 }, (_, i) => `/file-${i}.txt/1.1///\n`).join(""));
    assert.equal((await new CvsAdapter(base).inventory()).length, 3089);
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("dry-run update parses local, added, remote and unknown files without changing the checkout", async () => {
  const f = await fixture();
  try {
    const second = await checkout(f.process, f.root, "demo", path.join(f.base, "second"));
    await fs.writeFile(path.join(second, "remote.txt"), "base\n");
    await f.process.run(["add", "remote.txt"], second);
    await new CvsAdapter(second, f.process).commit(["remote.txt"], "add remote fixture");
    await f.parent.update();
    await fs.writeFile(path.join(second, "remote.txt"), "remote change\n");
    await new CvsAdapter(second, f.process).commit(["remote.txt"], "change remote fixture");
    await fs.writeFile(path.join(f.wc, "ordinary.txt"), "local change\n");
    await fs.writeFile(path.join(f.wc, "added.txt"), "added\n");
    await f.process.run(["add", "added.txt"], f.wc);
    await fs.writeFile(path.join(f.wc, "unknown.txt"), "unknown\n");
    const entries = await fs.readFile(path.join(f.wc, "CVS", "Entries"));
    const output = await f.process.run(["-n", "-q", "update"], f.wc);
    const parsed = parseUpdateStatus(output.stdout.toString("utf8"));
    assert.equal(parsed.get("ordinary.txt").state, "Locally Modified");
    assert.equal(parsed.get("added.txt").state, "Locally Added");
    assert.ok(["Needs Checkout", "Needs Patch"].includes(parsed.get("remote.txt").state));
    assert.equal(parsed.get("unknown.txt").state, "Unknown");
    let calls = 0;
    const adapter = new CvsAdapter(f.wc, {
      run: async (args, cwd, signal, allowed, options) => {
        calls++;
        assert.deepEqual(args, ["-n", "-q", "update"]);
        assert.equal(cwd, f.wc);
        assert.equal(options.timeoutMs, 180000);
        return f.process.run(args, cwd, signal, allowed, options);
      },
    });
    const files = await adapter.status();
    assert.equal(calls, 1);
    assert.deepEqual(files.map(file => [file.newPath, file.status]),
      [["added.txt", "added"], ["ordinary.txt", "modified"], ["remote.txt", "modified"], ["unknown.txt", "untracked"]]);
    assert.equal(await fs.readFile(path.join(f.wc, "remote.txt"), "utf8"), "base\n");
    assert.deepEqual(await fs.readFile(path.join(f.wc, "CVS", "Entries")), entries);
    await fs.writeFile(path.join(f.wc, "remote.txt"), "conflicting local change\n");
    assert.equal((await f.parent.status()).find(file => file.newPath === "remote.txt").status, "conflicts");
    await fs.rm(path.join(f.wc, "ordinary.txt"));
    await f.process.run(["remove", "ordinary.txt"], f.wc);
    assert.equal((await f.parent.status()).find(file => file.newPath === "ordinary.txt").state, "Locally Removed");
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test("update status maps CVSNT paths, conflicts and diagnostics using existing state semantics", () => {
  const parsed = parseUpdateStatus([
    "M modified.txt", "A added.txt", "R removed.txt", "C conflict.txt", "U checkout.txt", "P patch.txt", "? unknown.txt",
    "M folder\\file.txt", "cvs update: Updating folder",
    "cvs update: warning: `lost.txt' was lost",
    "cvs update: conflicts found in merge.txt",
  ].join("\r\n"));
  for (const [name, state] of Object.entries({
    "modified.txt": "Locally Modified", "added.txt": "Locally Added", "removed.txt": "Locally Removed",
    "conflict.txt": "Needs Merge", "checkout.txt": "Needs Checkout", "patch.txt": "Needs Patch", "unknown.txt": "Unknown",
    "folder/file.txt": "Locally Modified", "lost.txt": "Needs Checkout", "merge.txt": "Needs Merge",
  })) assert.deepEqual(parsed.get(name), parseStatus(`Status: ${state}`));
  assert.equal(parsed.size, 10);
});

test("status excludes nested and unlisted output and leaves silent files clean", async () => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "cvs-status-filter-"));
  try {
    await metadata(base, "demo", "/clean.txt/1.1///\n/modified.txt/1.1///\n");
    // 缺少 D/child/ 时，即使 Repository 路径相接也仍是独立子仓。
    await metadata(path.join(base, "child"), "demo/child", "/nested.txt/1.1///\n");
    const adapter = new CvsAdapter(base, {
      run: async () => ({ stdout: Buffer.from("M modified.txt\nM child/nested.txt\nM unlisted.txt\n? unknown.txt\nM ../escape.txt\n") }),
    });
    assert.deepEqual((await adapter.status()).map(file => [file.newPath, file.state]),
      [["clean.txt", "Up-to-date"], ["modified.txt", "Locally Modified"]]);
    assert.equal(adapter.getNestedBoundaries()[0].root, path.join(base, "child"));
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("large directory preflight remains bounded at 10000 directories", async () => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "cvs-large-tree-"));
  try {
    await metadata(base, "demo");
    // 普通子目录也计入边界预检，确保大树不会被旧 5000 上限误拒。
    for (let start = 0; start < 9999; start += 100)
      await Promise.all(Array.from({ length: Math.min(100, 9999 - start) }, (_, i) =>
        fs.mkdir(path.join(base, `directory-${start + i}`))));
    assert.deepEqual(await listNestedRepositories(base, "cvs"), []);
    assert.deepEqual(await new CvsAdapter(base).inventory(), []);
    await fs.mkdir(path.join(base, "one-too-many"));
    await assert.rejects(listNestedRepositories(base, "cvs"), { code: "BOUNDARY_UNAVAILABLE" });
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("inventory accepts 20000 files and rejects the next record explicitly", async () => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "cvs-file-limit-"));
  try {
    const records = Array.from({ length: 20000 }, (_, i) => `/file-${i}.txt/1.1///\n`).join("");
    await metadata(base, "demo", records);
    assert.equal((await new CvsAdapter(base).inventory()).length, 20000);
    await fs.appendFile(path.join(base, "CVS", "Entries"), "/extra.txt/1.1///\n");
    await assert.rejects(new CvsAdapter(base).inventory(), { code: "inventoryLimit" });
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("selected-file commits validate each selected status without a tree update", async () => {
  const f = await fixture();
  try {
    await fs.writeFile(path.join(f.wc, "ordinary.txt"), "selected change\n");
    const commands = [];
    const adapter = new CvsAdapter(f.wc, {
      run: (...args) => { commands.push(args[0]); return f.process.run(...args); },
    });
    await adapter.commit(["ordinary.txt"], "selected fixture");
    assert.deepEqual(commands.map(args => args[0]), ["status", "commit"]);
    await assert.rejects(adapter.commit(["ordinary.txt"], "reject unchanged"), { code: "commitState" });
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test("missing CVS client is missingClient while broken metadata is BOUNDARY_UNAVAILABLE", async () => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "cvs-missing-client-"));
  try {
    await metadata(base, "demo", "/ordinary.txt/1.1///\n");
    await assert.rejects(new CvsAdapter(base, new CvsProcess(path.join(base, "missing-cvs"))).status(), { code: "missingClient" });
    await fs.rm(path.join(base, "CVS", "Repository"));
    await assert.rejects(nearestRepositories(base), { code: "BOUNDARY_UNAVAILABLE" });
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("CVS session refresh distinguishes missing client from unavailable boundaries", async () => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "cvs-session-errors-"));
  try {
    const wc = path.join(base, "checkout");
    await metadata(wc, "demo", "/ordinary.txt/1.1///\n");
    const project = path.resolve(import.meta.dirname, "..");
    const bundle = path.join(base, "session.cjs");
    await build({
      entryPoints: [path.join(project, "src/cvs/session.ts")],
      bundle: true, platform: "node", format: "cjs", outfile: bundle,
      plugins: [{ name: "vscode-fixture", setup(build) {
        build.onResolve({ filter: /^vscode$/ }, () => ({ path: "vscode", namespace: "fixture" }));
        build.onLoad({ filter: /.*/, namespace: "fixture" }, () => ({ contents: `
          exports.EventEmitter=class {constructor(){this.event=()=>({dispose(){}});}fire(){}dispose(){}};
          exports.workspace = { isTrusted: true, getConfiguration: () => ({get: () => ${JSON.stringify(path.join(base, "missing-cvs"))}}) };
          exports.l10n = { t: text => text };
          exports.ProgressLocation = { Notification: 1 };
          exports.window = { withProgress: (_options, run) => run({}, {onCancellationRequested: () => ({dispose() {}})}) };
        ` }));
      } }],
    });
    const { CvsSession } = createRequire(import.meta.url)(bundle);
    let checks = 0;
    let lastSnapshot;
    let failed;
    const networkError = new Promise(resolve => { failed = resolve; });
    const session = new CvsSession("fixture", wc, async () => {
      checks++;
      assert.ok((await nearestRepositories(wc)).some(root => root.root === wc));
    }, snapshot => { lastSnapshot = snapshot; if (snapshot.error) failed(snapshot); });
    await session.refresh(undefined, true);
    const timeout = setTimeout(() => failed({error:"missing client snapshot timed out"}), 5000);
    const snapshot = await networkError;
    clearTimeout(timeout);
    assert.match(snapshot.error, /CVS was not found/);
    assert.ok(checks >= 2);
    await fs.rm(path.join(wc, "CVS", "Repository"));
    await session.refresh();
    assert.match(lastSnapshot.error, /Repository boundaries could not be fully verified/);
    session.dispose();
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

async function makeRepository(base, name, contents = "initial\n") {
  const repository = path.join(base, `${name}-repo`);
  const seed = path.join(base, `${name}-seed`);
  const process = new CvsProcess(cvsExecutable);
  const root = `:local:${repository}`;
  await fs.mkdir(repository);
  await fs.mkdir(seed);
  await process.run(["-d", root, "init"], base);
  await fs.writeFile(path.join(seed, "ordinary.txt"), contents);
  await process.run(
    ["-d", root, "import", "-m", "initial", "demo", "vendor", "start"],
    seed,
  );
  return { process, root };
}

async function fixture() {
  const base = await fs.realpath(
    await fs.mkdtemp(path.join(tmpdir(), "jettortoise-cvs-nesting-")),
  );
  const local = await makeRepository(base, "local");
  const wc = path.join(base, "parent");
  await checkout(local.process, local.root, "demo", wc);
  return { base, wc, ...local, parent: new CvsAdapter(wc, local.process) };
}

test("continuous CVS directories share the parent working copy", async () => {
  const f = await fixture();
  try {
    await fs.mkdir(path.join(f.wc, "continuous"));
    await f.process.run(["add", "continuous"], f.wc);
    await fs.writeFile(path.join(f.wc, "continuous", "child.txt"), "child\n");
    await f.process.run(["add", "continuous/child.txt"], f.wc);
    await f.parent.commit(["continuous/child.txt"], "add continuous child");

    assert.equal(
      await findWorkingCopy(path.join(f.wc, "continuous", "child.txt")),
      f.wc,
    );
    assert.deepEqual(
      (await f.parent.inventory()).map((file) => file.newPath),
      ["continuous/child.txt", "ordinary.txt"],
    );
    assert.deepEqual(f.parent.getNestedBoundaries(), []);
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});

test("independent CVS and Git children are excluded and block parent-wide mutations", async () => {
  const f = await fixture();
  try {
    // A normal parent operation still works before child boundaries exist.
    await fs.writeFile(path.join(f.wc, "ordinary.txt"), "parent edit\n");
    await f.parent.commit(["ordinary.txt"], "parent-only commit");

    const sameRoot = path.join(f.wc, "same-root-child");
    await checkout(f.process, f.root, "demo", sameRoot);
    const foreign = await makeRepository(f.base, "foreign", "foreign\n");
    const foreignRoot = path.join(f.wc, "foreign-child");
    await checkout(foreign.process, foreign.root, "demo", foreignRoot);
    const gitChild = path.join(f.wc, "git-child");
    await fs.mkdir(gitChild);
    await execFile("git", ["init", "--quiet"], { cwd: gitChild });
    const sentinel = path.join(f.base, "outside-sentinel");
    await fs.writeFile(sentinel, "unchanged\n");

    assert.equal(await findWorkingCopy(path.join(sameRoot, "ordinary.txt")), sameRoot);
    assert.equal(
      await findWorkingCopy(path.join(foreignRoot, "ordinary.txt")),
      foreignRoot,
    );
    const inventory = await f.parent.inventory();
    assert.ok(inventory.every((file) => !file.newPath.includes("child/")));
    const boundaries = f.parent.getNestedBoundaries();
    assert.deepEqual(
      new Set(boundaries.map((boundary) => boundary.root)),
      new Set([sameRoot, foreignRoot, gitChild]),
    );

    await fs.writeFile(path.join(sameRoot, "ordinary.txt"), "child edit\n");
    const child = new CvsAdapter(sameRoot, f.process);
    await child.commit(["ordinary.txt"], "child-only commit");
    assert.equal(
      await fs.readFile(path.join(f.wc, "ordinary.txt"), "utf8"),
      "parent edit\n",
    );
    await assert.rejects(
      f.parent.commit(["same-root-child/ordinary.txt"], "forbidden"),
      { code: "NESTED_REPOSITORY" },
    );
    await assert.rejects(f.parent.rollback("foreign-child/ordinary.txt"), {
      code: "NESTED_REPOSITORY",
    });
    const noBroadCommand = new CvsAdapter(f.wc, {
      run: async () => assert.fail("nested preflight invoked CVS update"),
    });
    // 显式登记的异 Root/Repository 子仓仍须在任何命令前被拒绝。
    await fs.appendFile(path.join(f.wc, "CVS", "Entries"), "D/same-root-child////\nD/foreign-child////\n");
    await assert.rejects(noBroadCommand.update(), {
      code: "NESTED_REPOSITORY",
    });
    assert.equal(await fs.readFile(sentinel, "utf8"), "unchanged\n");
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});

// 同项目未登记目录仍保护路径操作，-l 整树更新不访问它。
test("same-project CVS directories stay write boundaries for the parent", async () => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "cvs-same-project-"));
  try {
    await metadata(base, "demo", "/tracked.txt/1.1///\n");
    await fs.writeFile(path.join(base, "tracked.txt"), "tracked\n");
    await metadata(path.join(base, "build"), "demo/build");
    await metadata(path.join(base, "build", "classes"), "demo/build/classes");
    await fs.writeFile(path.join(base, "build", "classes", "Generated.class"), "class\n");
    await fs.writeFile(path.join(base, "build", "output.txt"), "output\n");
    const real = await fs.realpath(base);
    assert.deepEqual(await listNestedRepositories(base, "cvs"), [{ kind: "cvs", root: path.join(real, "build") }]);
    const calls = [];
    const adapter = new CvsAdapter(base, { run: async args => { calls.push(args); return {stdout: Buffer.alloc(0)}; } });
    const { files, unknown } = await adapter.localInventory();
    assert.deepEqual(files.map((file) => file.newPath), ["tracked.txt"]);
    assert.ok(unknown.every((name) => !name.startsWith("build/")), "same-project directory files became parent unversioned files");
    await adapter.update();
    assert.deepEqual(calls, [["-q", "update", "-l", "-P", "."]]);
    await assert.rejects(adapter.commit(["build/output.txt"], "forbidden"), { code: "NESTED_REPOSITORY" });
    await assert.rejects(adapter.rollback("build/output.txt"), { code: "NESTED_REPOSITORY" });
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

// S1: 本地刷新不能启动客户端，未知文件也需要进入 SCM。
test("SCM local status reads Entries.Log, timestamps and unknown files without CVS", async () => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "cvs-scm-local-"));
  try {
    await metadata(base, "demo", "/changed.txt/1.1/invalid timestamp//\n/added.txt/0///\n/removed.txt/-1.1///\n/missing.txt/1.1///\n");
    await fs.writeFile(path.join(base,"changed.txt"),"changed\n");
    await fs.writeFile(path.join(base,"added.txt"),"added\n");
    await fs.writeFile(path.join(base,"unknown.txt"),"unknown\n");
    const adapter = new CvsAdapter(base, {run(){throw new Error("local refresh called CVS");}});
    const files = await adapter.localStatus();
    assert.equal(files.find(f=>f.newPath==="changed.txt").state,"Locally Modified");
    assert.equal(files.find(f=>f.newPath==="added.txt").state,"Locally Added");
    assert.equal(files.find(f=>f.newPath==="removed.txt").state,"Locally Removed");
    assert.equal(files.find(f=>f.newPath==="missing.txt").state,"Missing");
    assert.equal(files.find(f=>f.newPath==="unknown.txt").state,"Unknown");
    await fs.writeFile(path.join(base,"unknown.txt"),"saved\n");
    assert.deepEqual((await adapter.localStatus(["unknown.txt"])).map(f=>f.newPath),["unknown.txt"]);
  } finally {await fs.rm(base,{recursive:true,force:true});}
});

// 约 2500 个连续目录与原有 3089 文件规模，客户端不得介入本地段。
test("SCM local scale benchmark has 3089 files in 2500 directories", async () => {
  const base=await fs.mkdtemp(path.join(tmpdir(),"cvs-scm-scale-"));
  try {
    const count=2499;
    await metadata(base,"demo",Array.from({length:count},(_,i)=>`D/d-${i}////\n`).join("")+Array.from({length:590},(_,i)=>`/root-${i}.txt/1.1///\n`).join(""));
    for(let start=0;start<count;start+=32)await Promise.all(Array.from({length:Math.min(32,count-start)},async(_,i)=>{
      const n=start+i,directory=path.join(base,`d-${n}`);
      await metadata(directory,`demo/d-${n}`,"/file.txt/1.1///\n");
      await fs.writeFile(path.join(directory,"file.txt"),"fixture\n");
    }));
    const adapter=new CvsAdapter(base,{run(){throw new Error("local benchmark called CVS");}});
    const start=performance.now();const files=await adapter.localStatus();const elapsed=performance.now()-start;
    assert.equal(files.length,3089);
    console.log(JSON.stringify({benchmark:"localStatus",files:3089,directories:2500,milliseconds:Number(elapsed.toFixed(2)),platform:process.platform}));
    const targeted=performance.now();assert.equal((await adapter.localStatus(["d-7/file.txt"])).length,1);
    console.log(JSON.stringify({benchmark:"localStatusOneFile",milliseconds:Number((performance.now()-targeted).toFixed(2))}));
  }finally{await fs.rm(base,{recursive:true,force:true});}
});

// 拦截提示使用相对目录，最多列出前三个。
test("nested boundary errors name three relative directories and remaining count", async () => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "cvs-boundary-message-"));
  try {
    await metadata(base, "demo");
    const names = ["one", "two", "three", "four"];
    for (const name of names) await metadata(path.join(base, name), `other/${name}`);
    await assert.rejects(assertNoNestedRepositories(base, "cvs"), error => {
      assert.equal(error.code, "NESTED_REPOSITORY");
      assert.equal(error.boundaries.length, 4);
      const shown = error.boundaries.slice(0, 3).map(item => path.relative(base, item.root));
      assert.equal(error.message, `Nested repositories block this operation: ${shown.join(", ")} and 1 more.`);
      assert.ok(!error.message.includes(base));
      return true;
    });
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

// 修正 3：真实本地 CVS 先验证 -l 的范围，再验证产品入口。
test("registered update preserves unregistered build and fetches known-directory changes", async () => {
  const f = await fixture();
  try {
    for (const name of ["src", "src/deep", "side"]) {
      await fs.mkdir(path.join(f.wc, name));
      await f.process.run(["add", name], f.wc);
      await fs.writeFile(path.join(f.wc, name, "kept.txt"), "base\n");
      await f.process.run(["add", `${name}/kept.txt`], f.wc);
    }
    await f.process.run(["commit", "-m", "seed directories"], f.wc);
    const peer = await checkout(f.process, f.root, "demo", path.join(f.base, "peer"));
    for (const name of ["build", "server-new"]) {
      await fs.mkdir(path.join(peer, name));
      await f.process.run(["add", name], peer);
      await fs.writeFile(path.join(peer, name, "sentinel.txt"), "server base\n");
      await f.process.run(["add", `${name}/sentinel.txt`], peer);
    }
    await f.process.run(["commit", "-m", "server directories"], peer);
    const buildDir = path.join(f.wc, "build");
    await checkout(f.process, f.root, "demo/build", buildDir);
    await fs.writeFile(path.join(buildDir, "sentinel.txt"), "protected build edit\n");
    const entriesFile = path.join(f.wc, "CVS", "Entries");
    await fs.writeFile(entriesFile, (await fs.readFile(entriesFile, "utf8")).replace(/^D\/build\/.*\n?/gm, ""));
    await fs.rm(path.join(f.wc, "CVS", "Entries.Log"), { force: true });
    assert.match(await fs.readFile(entriesFile, "utf8"), /^D\/src\//m);
    const before = await fs.readFile(path.join(buildDir, "CVS", "Entries"));
    const changePeer = async text => {
      for (const name of ["src", "src/deep", "side"])
        await fs.writeFile(path.join(peer, name, "kept.txt"), text);
      await fs.writeFile(path.join(peer, "build", "sentinel.txt"), text);
      await f.process.run(["commit", "-m", text.trim()], peer);
    };
    const check = async text => {
      for (const name of ["src", "src/deep", "side"])
        assert.equal(await fs.readFile(path.join(f.wc, name, "kept.txt"), "utf8"), text);
      assert.equal(await fs.readFile(path.join(buildDir, "sentinel.txt"), "utf8"), "protected build edit\n");
      assert.deepEqual(await fs.readFile(path.join(buildDir, "CVS", "Entries")), before);
      await assert.rejects(fs.access(path.join(f.wc, "server-new")), { code: "ENOENT" });
    };
    await changePeer("raw explicit update\n");
    const raw = await f.process.run(["-q", "update", "-l", "-P", ".", "./src", "./src/deep", "./side"], f.wc);
    console.log("fix3 explicit -l probe", raw.stdout.toString());
    await check("raw explicit update\n");
    await changePeer("product explicit update\n");
    await fs.writeFile(path.join(peer, "src", "new.txt"), "new server file\n");
    await f.process.run(["add", "src/new.txt"], peer);
    await f.process.run(["commit", "-m", "new known-directory file"], peer);
    const calls = [];
    const adapter = new CvsAdapter(f.wc, { run: (...args) => { calls.push(args[0]); return f.process.run(...args); } });
    await adapter.update();
    assert.deepEqual(calls, [["-q", "update", "-l", "-P", ".", "./side", "./src", "./src/deep"]]);
    await check("product explicit update\n");
    assert.equal(await fs.readFile(path.join(f.wc, "src", "new.txt"), "utf8"), "new server file\n");
    await assert.rejects(adapter.rollback("build/sentinel.txt"), { code: "NESTED_REPOSITORY" });
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test("registered update rejects listed foreign CVS and Git boundaries with directory names", async () => {
  const f = await fixture();
  try {
    const foreign = await makeRepository(f.base, "foreign-listed");
    await checkout(foreign.process, foreign.root, "demo", path.join(f.wc, "foreign"));
    const adapter = new CvsAdapter(f.wc, { run: () => assert.fail("boundary preflight invoked CVS") });
    await fs.appendFile(path.join(f.wc, "CVS", "Entries"), "D/foreign////\n");
    await assert.rejects(adapter.update(), error => error.code === "NESTED_REPOSITORY" && /foreign/.test(error.message));
    await fs.writeFile(path.join(f.wc, "CVS", "Entries.Log"), "R D/foreign////\n");
    const gitDir = path.join(f.wc, "listed-git");
    await fs.mkdir(gitDir);
    await f.process.run(["add", "listed-git"], f.wc);
    await execFile("git", ["init", "--quiet"], { cwd: gitDir });
    await assert.rejects(adapter.update(), error => error.code === "NESTED_REPOSITORY" && /listed-git/.test(error.message));
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test("registered update applies Entries.Log A and R and ignores missing directories", async () => {
  const f = await fixture();
  try {
    for (const name of ["included", "excluded"]) {
      await fs.mkdir(path.join(f.wc, name));
      await f.process.run(["add", name], f.wc);
      await fs.writeFile(path.join(f.wc, name, "kept.txt"), "base\n");
      await f.process.run(["add", `${name}/kept.txt`], f.wc);
    }
    await f.process.run(["commit", "-m", "log seed"], f.wc);
    const peer = await checkout(f.process, f.root, "demo", path.join(f.base, "peer"));
    for (const name of ["included", "excluded"])
      await fs.writeFile(path.join(peer, name, "kept.txt"), "server change\n");
    await f.process.run(["commit", "-m", "log changes"], peer);
    await fs.writeFile(path.join(f.wc, "CVS", "Entries"), "/ordinary.txt/1.1///\nD/excluded////\nD/missing////\nD/unmanaged////\n");
    await fs.mkdir(path.join(f.wc, "unmanaged"));
    await fs.writeFile(path.join(f.wc, "CVS", "Entries.Log"), "A D/included////\nR D/excluded////\n");
    const calls = [];
    await new CvsAdapter(f.wc, {run: (...args) => { calls.push(args[0]); return f.process.run(...args); }}).update();
    assert.deepEqual(calls, [["-q", "update", "-l", "-P", ".", "./included"]]);
    assert.equal(await fs.readFile(path.join(f.wc, "included", "kept.txt"), "utf8"), "server change\n");
    assert.equal(await fs.readFile(path.join(f.wc, "excluded", "kept.txt"), "utf8"), "base\n");
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test("registered update batches real CVS commands within 8000 characters under one queue signal", async () => {
  const f = await fixture();
  try {
    const names = Array.from({length: 110}, (_, i) => `dir-${String(i).padStart(3, "0")}-${"x".repeat(80)}`);
    for (const name of names) await fs.mkdir(path.join(f.wc, name));
    await f.process.run(["add", ...names], f.wc);
    for (const name of names) await fs.writeFile(path.join(f.wc, name, "file.txt"), "base\n");
    await f.process.run(["add", ...names.map(name => `${name}/file.txt`)], f.wc);
    await f.process.run(["commit", "-m", "batch seed"], f.wc);
    const peer = await checkout(f.process, f.root, "demo", path.join(f.base, "peer"));
    for (const name of names) await fs.writeFile(path.join(peer, name, "file.txt"), "server batch\n");
    await f.process.run(["commit", "-m", "batch changes"], peer);
    const calls = [], queue = new SerialQueue();
    let activeSignal, queuedRan = false;
    const adapter = new CvsAdapter(f.wc, { run: async (args, cwd, signal, ...rest) => {
      assert.equal(signal, activeSignal); assert.equal(queuedRan, false);
      assert.deepEqual(args.slice(0, 4), ["-q", "update", "-l", "-P"]);
      assert.ok([cvsExecutable, "-f", ...args].map(arg => JSON.stringify(arg)).join(" ").length <= 8000);
      calls.push(args); return f.process.run(args, cwd, signal, ...rest);
    }});
    const update = queue.run(signal => { activeSignal = signal; return adapter.update(signal); });
    const after = queue.run(() => { queuedRan = true; });
    await update; await after;
    assert.ok(calls.length > 1);
    assert.deepEqual(calls.flatMap(args => args.slice(4)), [".", ...names.map(name => `./${name}`)]);
    for (const name of names) assert.equal(await fs.readFile(path.join(f.wc, name, "file.txt"), "utf8"), "server batch\n");
    console.log("fix3 real batches", calls.map(args => ({directories: args.length - 4, characters: [cvsExecutable, "-f", ...args].map(arg => JSON.stringify(arg)).join(" ").length})));
    let cancelledCalls = 0;
    const cancelled = new CvsAdapter(f.wc, {run: async (...args) => {
      cancelledCalls++;
      const result = await f.process.run(...args);
      queue.cancel();
      return result;
    }});
    await assert.rejects(queue.run(signal => cancelled.update(signal)), {code: "cancelled"});
    assert.equal(cancelledCalls, 1, "cancelled update started another batch");
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test("registered update fetches new files into an initially empty registered directory", async () => {
  const f = await fixture();
  try {
    const names = ["empty", "space dir", "-option"];
    for (const name of names) {
      await fs.mkdir(path.join(f.wc, name));
      await f.process.run(["add", `./${name}`], f.wc);
    }
    const peer = await checkout(f.process, f.root, "demo", path.join(f.base, "peer"));
    for (const name of names) {
      await fs.writeFile(path.join(peer, name, "new.txt"), "server new file\n");
      await f.process.run(["add", `./${name}/new.txt`], peer);
    }
    await f.process.run(["commit", "-m", "empty directory additions"], peer);
    await f.parent.update();
    for (const name of names)
      assert.equal(await fs.readFile(path.join(f.wc, name, "new.txt"), "utf8"), "server new file\n");
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});

test("registered update retains symlink and malformed metadata protections before commands", async () => {
  const base = await fs.mkdtemp(path.join(tmpdir(), "cvs-update-safety-"));
  try {
    await metadata(base, "demo", "/file.txt/1.1///\n");
    const adapter = new CvsAdapter(base, {run: () => assert.fail("unsafe update invoked CVS")});
    await fs.symlink(path.join(base, "outside.txt"), path.join(base, "file.txt"));
    await assert.rejects(adapter.update(), {code: "symlink"});
    await fs.rm(path.join(base, "file.txt"));
    await fs.appendFile(path.join(base, "CVS", "Entries"), "D/../\n");
    await assert.rejects(adapter.update(), {code: "BOUNDARY_UNAVAILABLE"});
    await fs.writeFile(path.join(base, "CVS", "Entries"), "D/linked////\n");
    await fs.symlink(base, path.join(base, "linked"));
    await assert.rejects(adapter.update(), {code: "BOUNDARY_UNAVAILABLE"});
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});
