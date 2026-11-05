import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CvsAdapter, CvsProcess, SerialQueue, checkout, cvsRoot, findWorkingCopy, relativeFile, revision } from "../src/cvs/core.mjs";
import { validateMessage } from "../src/cvs/protocol.mjs";

async function fixture() {
  const base = await fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "jettortoise-cvs-")));
  const repository = path.join(base, "repo"), seed = path.join(base, "seed"), wc = path.join(base, "working copy 中文");
  await fs.mkdir(repository); await fs.mkdir(seed);
  const cvsProcess = new CvsProcess(process.env.JETTORTOISE_TEST_CVS || "/opt/homebrew/bin/cvs");
  const root = `:local:${repository}`;
  await cvsProcess.run(["-d", root, "init"], base);
  await fs.writeFile(path.join(seed, "中文 file.txt"), "first line\n"); await fs.writeFile(path.join(seed, "other.txt"), "other\n");
  await cvsProcess.run(["-d", root, "import", "-m", "initial", "demo", "vendor", "start"], seed);
  await checkout(cvsProcess, root, "demo", wc);
  return { base, root, wc, seed, process: cvsProcess, cvs: new CvsAdapter(wc, cvsProcess) };
}
test("temporary local CVS: checkout, discovery, history, content, diff, commit, update, rollback", async () => {
  const f = await fixture();
  try {
    assert.equal(await findWorkingCopy(path.join(f.wc, "中文 file.txt")), f.wc);
    assert.equal((await f.cvs.inventory()).length, 2);
    assert.ok((await f.cvs.log("中文 file.txt")).some(item => item.revisionId === "1.1"));
    assert.match((await f.cvs.content("中文 file.txt", "1.1")).toString(), /first line\n$/);
    await fs.writeFile(path.join(f.wc, "中文 file.txt"), "second line\n");
    assert.match(await f.cvs.diff("中文 file.txt"), /\+second line/);
    await f.cvs.commit(["中文 file.txt"], "temporary fixture commit");
    assert.ok((await f.cvs.log("中文 file.txt")).some(item => item.subject === "temporary fixture commit" && item.revisionId !== "1.1"));
    assert.ok((await f.cvs.status()).every(item => item.state === "Up-to-date"));
    const second = await checkout(f.process, f.root, "demo", path.join(f.base, "second")); const other = new CvsAdapter(second, f.process);
    await fs.writeFile(path.join(second, "other.txt"), "upstream change\n"); await other.commit(["other.txt"], "fixture update"); await f.cvs.update();
    assert.equal(await fs.readFile(path.join(f.wc, "other.txt"), "utf8"), "upstream change\n");
    await fs.writeFile(path.join(f.wc, "中文 file.txt"), "discard me\n"); const backup = await f.cvs.rollback("中文 file.txt");
    assert.match(await fs.readFile(path.join(f.wc, "中文 file.txt"), "utf8"), /second line\n$/); assert.equal(await fs.readFile(path.join(f.wc, backup), "utf8"), "discard me\n");
    await assert.rejects(f.cvs.content("中文 file.txt", "99.99"), { code: "revision" });
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});
test("temporary local CVS: a locally deleted registered file stays a local deletion and commits as cvs remove", async () => {
  const f = await fixture();
  try {
    await fs.rm(path.join(f.wc, "other.txt"));
    const deleted = (await f.cvs.status()).find(item => item.newPath === "other.txt");
    assert.equal(deleted.state, "Missing"); assert.equal(deleted.status, "deleted");
    await f.cvs.commit(["other.txt"], "delete other");
    assert.equal((await f.cvs.inventory()).some(item => item.newPath === "other.txt"), false);
    const second = await checkout(f.process, f.root, "demo", path.join(f.base, "second"));
    await assert.rejects(fs.access(path.join(second, "other.txt")));
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});
test("temporary local CVS: an edited merge conflict becomes a local modification and commits", async () => {
  const f = await fixture();
  try {
    const second = await checkout(f.process, f.root, "demo", path.join(f.base, "second"));
    await fs.writeFile(path.join(second, "other.txt"), "colleague\n"); await new CvsAdapter(second, f.process).commit(["other.txt"], "colleague");
    await fs.writeFile(path.join(f.wc, "other.txt"), "mine\n"); await f.cvs.update();
    const conflicted = async () => (await f.cvs.localStatus()).find(item => item.newPath === "other.txt").state;
    assert.equal(await conflicted(), "File had conflicts on merge");
    await new Promise(done => setTimeout(done, 1100));
    await fs.appendFile(path.join(f.wc, "other.txt"), "\n");
    assert.equal(await conflicted(), "Locally Modified");
    await assert.rejects(f.cvs.commit(["other.txt"], "markers left"));
    await fs.writeFile(path.join(f.wc, "other.txt"), "mine and colleague\n");
    await f.cvs.commit(["other.txt"], "resolved");
    assert.ok((await f.cvs.log("other.txt")).some(item => item.subject === "resolved"));
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});
test("temporary local CVS: server-new files are incoming until update; update reports conflicts and hides .# backups", async () => {
  const f = await fixture();
  try {
    const second = await checkout(f.process, f.root, "demo", path.join(f.base, "second")), other = new CvsAdapter(second, f.process);
    await fs.writeFile(path.join(second, "fresh.txt"), "server new\n"); await other.add(["fresh.txt"]); await other.commit(["fresh.txt"], "server new file");
    await fs.writeFile(path.join(second, "other.txt"), "colleague\n"); await other.commit(["other.txt"], "colleague");
    const fresh = (await f.cvs.status()).find(item => item.newPath === "fresh.txt");
    assert.equal(fresh?.state, "Needs Checkout", "server-new file missing from incoming");
    // 本地刷新（焦点、保存）沿用最近网络结果，不能把服务器新文件丢掉。
    assert.equal((await f.cvs.localStatus()).find(item => item.newPath === "fresh.txt")?.state, "Needs Checkout");
    await fs.writeFile(path.join(f.wc, "other.txt"), "mine\n");
    assert.deepEqual(await f.cvs.update(), ["other.txt"]);
    assert.equal(await fs.readFile(path.join(f.wc, "fresh.txt"), "utf8"), "server new\n");
    const local = await f.cvs.localStatus();
    assert.equal(local.find(item => item.newPath === "fresh.txt").state, "Up-to-date", "updated server-new file still incoming");
    assert.ok((await fs.readdir(f.wc)).some(name => name.startsWith(".#other.txt.")), "fixture did not produce a CVS conflict backup");
    assert.deepEqual(local.filter(item => item.state === "Unknown").map(item => item.newPath), [], ".# backup listed as unversioned");
    assert.ok((await f.cvs.status()).every(item => item.newPath !== "fresh.txt" || item.state === "Up-to-date"));
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});
// 一次提交超过 2000 个文件（旧上限）：状态查询、cvs remove 与 cvs commit 都按 8000 字符分批。
test("temporary local CVS: committing 2500 files runs in command-line batches", async () => {
  const f = await fixture();
  try {
    const seed = path.join(f.base, "bulk-seed");
    const names = Array.from({ length: 2500 }, (_, index) => `bulk/d${index % 25}/F${String(index).padStart(4, "0")}.txt`);
    for (let index = 0; index < 25; index++) await fs.mkdir(path.join(seed, `bulk/d${index}`), { recursive: true });
    await Promise.all(names.map((name) => fs.writeFile(path.join(seed, name), "v1\n")));
    await f.process.run(["-d", f.root, "import", "-m", "bulk", "bulk", "vendor", "start"], seed);
    const wc = await checkout(f.process, f.root, "bulk", path.join(f.base, "bulk-wc"));
    const runs = [];
    const adapter = new CvsAdapter(wc, { executable: f.process.executable, run: (...args) => { runs.push(args[0]); return f.process.run(...args); } });
    const files = names;
    await Promise.all(files.slice(1).map((name) => fs.writeFile(path.join(wc, name), "v2\n")));
    await fs.rm(path.join(wc, files[0]));
    const started = Date.now();
    await adapter.commit(files, "bulk commit");
    const commits = runs.filter((args) => args[0] === "commit");
    console.log(JSON.stringify({ benchmark: "cvsBulkCommit", files: files.length, batches: commits.length, milliseconds: Date.now() - started }));
    assert.ok(commits.length > 1, "commit was not batched");
    assert.ok(runs.every((args) => args.reduce((total, value) => total + 2 * value.length + 3, 0) < 8000), "a batch exceeds 8000 characters");
    assert.equal(runs.filter((args) => args[0] === "remove").length, 1);
    const after = await new CvsAdapter(wc, f.process).status();
    assert.ok(after.every((item) => item.state === "Up-to-date"), "some files were not committed");
    assert.equal(after.length, files.length - 1);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});
test("CVS input, symlink and cancellation boundaries reject hostile inputs", async () => {
  for (const value of ["../a", "a/../b", "/etc/passwd", "CVS/Root", "a\\b", "./a", "a//b"]) assert.throws(() => relativeFile(value));
  for (const value of ["-r1.1", "1.1;touch x", "HEAD", ""]) assert.throws(() => revision(value));
  for (const value of [":ext:host:/repo", ":pserver:user:secret@host:/repo", "-d /tmp"]) assert.throws(() => cvsRoot(value));
  for (const value of [":pserver:dev@host:/repo", ":pserver:dev@127.0.0.1:2401/repo", ":pserver:dev@host:2401:/repo"]) assert.equal(cvsRoot(value), value);
  for (const value of [":pserver:dev@host/repo", ":pserver:dev@host:240100/repo"]) assert.throws(() => cvsRoot(value));
  for (const value of [{ type: "push" }, { type: "history", path: "a", options: "-x" }, { type: "compare", path: "a", revision: "--help" }]) assert.throws(() => validateMessage(value, "workspace"));
  const f = await fixture();
  try {
    await fs.rename(path.join(f.wc, "other.txt"), path.join(f.base, "outside")); await fs.symlink(path.join(f.base, "outside"), path.join(f.wc, "other.txt"));
    await assert.rejects(f.cvs.content("other.txt", "1.1"), { code: "symlink" });
    const queue = new SerialQueue(); let release; const first = queue.run(async signal => { await new Promise(done => { release = done; }); assert.equal(signal.aborted, true); }); const second = queue.run(async () => assert.fail("cancelled queued job ran"));
    await new Promise(done => setImmediate(done)); queue.cancel(); release(); await first; await assert.rejects(second, { code: "cancelled" });
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});
