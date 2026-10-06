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
    const second = await checkout(f.process, f.root, "demo", path.join(f.base, "second")); const other = new CvsAdapter(second, f.process);
    await fs.writeFile(path.join(second, "other.txt"), "upstream change\n"); await other.commit(["other.txt"], "fixture update"); await f.cvs.update();
    assert.equal(await fs.readFile(path.join(f.wc, "other.txt"), "utf8"), "upstream change\n");
    await fs.writeFile(path.join(f.wc, "中文 file.txt"), "discard me\n"); const backup = await f.cvs.rollback("中文 file.txt");
    assert.match(await fs.readFile(path.join(f.wc, "中文 file.txt"), "utf8"), /second line\n$/); assert.equal(await fs.readFile(path.join(f.wc, backup), "utf8"), "discard me\n");
    await assert.rejects(f.cvs.content("中文 file.txt", "99.99"), { code: "revision" });
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});
test("CVS input, symlink and cancellation boundaries reject hostile inputs", async () => {
  for (const value of ["../a", "a/../b", "/etc/passwd", "CVS/Root", "a\\b", "./a", "a//b"]) assert.throws(() => relativeFile(value));
  for (const value of ["-r1.1", "1.1;touch x", "HEAD", ""]) assert.throws(() => revision(value));
  for (const value of [":ext:host:/repo", ":pserver:user:secret@host:/repo", "-d /tmp"]) assert.throws(() => cvsRoot(value));
  for (const value of [{ type: "push" }, { type: "history", path: "a", options: "-x" }, { type: "compare", path: "a", revision: "--help" }]) assert.throws(() => validateMessage(value, "workspace"));
  const f = await fixture();
  try {
    await fs.rename(path.join(f.wc, "other.txt"), path.join(f.base, "outside")); await fs.symlink(path.join(f.base, "outside"), path.join(f.wc, "other.txt"));
    await assert.rejects(f.cvs.content("other.txt", "1.1"), { code: "symlink" });
    const queue = new SerialQueue(); let release; const first = queue.run(async signal => { await new Promise(done => { release = done; }); assert.equal(signal.aborted, true); }); const second = queue.run(async () => assert.fail("cancelled queued job ran"));
    await new Promise(done => setImmediate(done)); queue.cancel(); release(); await first; await assert.rejects(second, { code: "cancelled" });
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});
