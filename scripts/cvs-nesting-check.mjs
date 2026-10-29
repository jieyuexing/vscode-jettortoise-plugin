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
  isCvsContinuation,
  listNestedRepositories,
  nearestRepositories,
} from "../src/repositories/boundaries.cjs";
import {
  CvsAdapter,
  CvsProcess,
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
    const { CvsRepositorySession } = createRequire(import.meta.url)(bundle);
    let checks = 0;
    const session = new CvsRepositorySession({}, { id: "fixture", kind: "cvs", root: wc, title: "fixture" }, async () => {
      checks++;
      assert.ok((await nearestRepositories(wc)).some(root => root.root === wc));
    });
    await assert.rejects(session.refresh(), /CVS was not found/);
    assert.ok(checks >= 2);
    await fs.rm(path.join(wc, "CVS", "Repository"));
    await assert.rejects(session.refresh(), /Repository boundaries could not be fully verified/);
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
    await assert.rejects(noBroadCommand.update(), {
      code: "NESTED_REPOSITORY",
    });
    assert.equal(await fs.readFile(sentinel, "utf8"), "unchanged\n");
  } finally {
    await fs.rm(f.base, { recursive: true, force: true });
  }
});

// 修正 A：同项目目录不再单列，但仍是父工作副本的写边界。
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
    const adapter = new CvsAdapter(base, { run: async () => assert.fail("nested preflight invoked CVS") });
    const { files, unknown } = await adapter.localInventory();
    assert.deepEqual(files.map((file) => file.newPath), ["tracked.txt"]);
    assert.ok(unknown.every((name) => !name.startsWith("build/")), "same-project directory files became parent unversioned files");
    await assert.rejects(adapter.update(), { code: "NESTED_REPOSITORY" });
    await assert.rejects(adapter.commit(["build/output.txt"], "forbidden"), { code: "NESTED_REPOSITORY" });
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
