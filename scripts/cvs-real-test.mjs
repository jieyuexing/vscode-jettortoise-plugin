import test from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CvsAdapter, CvsProcess, SerialQueue, checkout, cvsRoot, findWorkingCopy, relativeFile, revision } from "../src/cvs/core.mjs";
import { groupCommits } from "../src/cvs/log.mjs";
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
    await fs.writeFile(path.join(f.wc, "中文 file.txt"), "discard me\n"); const [backup] = await f.cvs.rollback(["中文 file.txt"]);
    assert.match(backup, /^\.#中文 file\.txt\.1\.\d+$/);
    assert.match(await fs.readFile(path.join(f.wc, "中文 file.txt"), "utf8"), /second line\n$/); assert.equal(await fs.readFile(path.join(f.wc, backup), "utf8"), "discard me\n");
    await assert.rejects(f.cvs.rollback(["missing.txt"]), { code: "path" });
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
    // 回滚同样按 8000 字符分批 cvs update -C，不逐文件取修订；备份 .#<文件>.<修订> 不列为未受版本控制。
    const kept = files.slice(1);
    await Promise.all(kept.map((name) => fs.writeFile(path.join(wc, name), "v3\n")));
    runs.length = 0;
    const progress = [];
    const rollbackStarted = Date.now();
    const backups = await adapter.rollback(kept, undefined, (done, total) => progress.push([done, total]));
    const updates = runs.filter((args) => args.includes("-C"));
    console.log(JSON.stringify({ benchmark: "cvsBulkRollback", files: kept.length, batches: updates.length, milliseconds: Date.now() - rollbackStarted }));
    assert.ok(updates.length > 1 && updates.length === runs.length, "rollback did not run as batched update -C only");
    assert.ok(runs.every((args) => args.reduce((total, value) => total + 2 * value.length + 3, 0) < 8000), "a rollback batch exceeds 8000 characters");
    assert.deepEqual(progress.at(-1), [kept.length, kept.length]);
    assert.equal(progress.length, updates.length);
    for (const name of [kept[0], kept.at(-1)]) assert.equal(await fs.readFile(path.join(wc, name), "utf8"), "v2\n");
    assert.equal(backups.length, kept.length);
    assert.equal(await fs.readFile(path.join(wc, backups[0]), "utf8"), "v3\n");
    const local = await new CvsAdapter(wc, f.process).localStatus();
    assert.ok(local.every((item) => item.state === "Up-to-date"), "rolled back files or backups still listed");
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});
// 未受版本控制按 CVS 内置忽略表：本地清单与 cvs -n update 的 ? 行一致。
test("temporary local CVS: local unversioned files follow the built-in CVS ignore list like cvs -n update", async () => {
  const f = await fixture();
  try {
    const ignored = ["core", "RCSLOG", "tags", "TAGS", ".make.state", ".nse_depinfo", "#x", ".#x", "cvslog.1", ",x", "CVS.adm", ".del-x", "x.a", "x.olb", "x.o", "x.obj", "x.so", "x.Z", "x~", "x.old", "x.elc", "x.ln", "x.bak", "x.BAK", "x.orig", "x.rej", "x.exe", "_$x", "x$"];
    for (const name of [...ignored, "keep.txt", "x.class", "x.o.txt"]) await fs.writeFile(path.join(f.wc, name), "1\n");
    for (const name of ["RCS", "SCCS", "kept-dir"]) { await fs.mkdir(path.join(f.wc, name)); await fs.writeFile(path.join(f.wc, name, "f"), "1\n"); }
    const unknown = (items) => items.filter((item) => item.state === "Unknown").map((item) => item.newPath).sort();
    const expected = ["keep.txt", "kept-dir/", "x.class", "x.o.txt"];
    assert.deepEqual(unknown(await f.cvs.status()), expected, "fixture differs from cvs -n update");
    assert.deepEqual(unknown(await f.cvs.localStatus()), expected, "local inventory lists CVS-ignored names");
    assert.deepEqual(unknown(await f.cvs.localStatus(["x.o", "keep.txt"])), ["keep.txt"]);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});
// 用户层规则按 CVS 客户端顺序叠加：内置表 → ~/.cvsignore → CVSIGNORE → 本目录 .cvsignore，"!" 清空此前规则；改规则后缓存失效。
test("temporary local CVS: local unversioned files follow ~/.cvsignore, CVSIGNORE and per-directory .cvsignore like cvs -n update", async () => {
  const f = await fixture(), saved = { HOME: process.env.HOME, CVSIGNORE: process.env.CVSIGNORE };
  try {
    const home = path.join(f.base, "home"); await fs.mkdir(home); process.env.HOME = home; delete process.env.CVSIGNORE;
    for (const directory of ["sub", "sub/deep"]) { await fs.mkdir(path.join(f.wc, directory)); await f.process.run(["-Q", "add", directory], f.wc); }
    const names = ["x.log", "y.o", "keep.txt", "build1", "buildA", "ax.tmp", "abx.tmp", "#h", ".#bk", "z.txt"], files = [];
    for (const directory of ["", "sub/", "sub/deep/"]) {
      for (const name of names) { await fs.writeFile(path.join(f.wc, directory + name), "1\n"); files.push(directory + name); }
      await fs.mkdir(path.join(f.wc, directory + ".gradle")); await fs.writeFile(path.join(f.wc, directory + ".gradle", "f"), "1\n");
    }
    await fs.writeFile(path.join(f.wc, ".cvsignore"), ".gradle *.log\nbuild[0-9] ?x.tmp\n"); await fs.writeFile(path.join(f.wc, "sub", ".cvsignore"), "!\nkeep*\n");
    files.push(".cvsignore", "sub/.cvsignore");
    const unknown = (items) => items.filter((item) => item.state === "Unknown").map((item) => item.newPath.replace(/\/$/, "")).sort();
    const cvsUpdate = async () => {
      const { stdout } = await promisify(execFile)(f.process.executable, ["-f", "-n", "-q", "update"], { cwd: f.wc, env: { ...process.env, LC_ALL: "C" } });
      return stdout.split("\n").filter((line) => line.startsWith("? ")).map((line) => line.slice(2)).sort();
    };
    const compare = async (label) => {
      const expected = await cvsUpdate();
      assert.deepEqual(unknown(await f.cvs.localStatus()), expected, `${label}: local inventory differs from cvs -n update`);
      assert.deepEqual(unknown(await f.cvs.localStatus(files)), expected.filter((name) => !name.endsWith(".gradle")), `${label}: per-file refresh differs from cvs -n update`);
      assert.deepEqual(unknown(await f.cvs.status()), expected, `${label}: network refresh differs from cvs -n update`);
      return expected;
    };
    const plain = await compare("directory rules");
    for (const name of ["abx.tmp", "buildA", "keep.txt", "sub/#h", "sub/.gradle", "sub/y.o", "sub/deep/.gradle", "sub/deep/keep.txt", "sub/deep/x.log"]) assert.ok(plain.includes(name), `fixture lost ${name}`);
    for (const name of [".gradle", "x.log", "build1", "ax.tmp", "y.o", "sub/keep.txt", "sub/deep/y.o"]) assert.ok(!plain.includes(name), `fixture lists ${name}`);
    await fs.writeFile(path.join(home, ".cvsignore"), "z.txt\n");
    assert.ok(!(await compare("home rules")).includes("sub/deep/z.txt"));
    process.env.CVSIGNORE = "! ab*";
    const bang = await compare("CVSIGNORE with !");
    assert.ok(bang.includes("z.txt") && bang.includes("y.o") && !bang.includes("abx.tmp"));
    await fs.writeFile(path.join(f.wc, "sub", ".cvsignore"), "!\nkeep* z*\n");
    assert.ok(!(await compare("edited .cvsignore")).includes("sub/z.txt"));
    await fs.rm(path.join(f.wc, ".cvsignore"));
    assert.ok((await compare("removed .cvsignore")).includes(".gradle"));
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await fs.rm(f.base, { recursive: true, force: true });
  }
});
// C locale 字符类同时核对独立预期与真实 CVS；同一实例逐次改规则，覆盖缓存失效。
test("temporary local CVS: POSIX character classes and combinations follow C locale fnmatch", async () => {
  const f = await fixture(), saved = { HOME: process.env.HOME, CVSIGNORE: process.env.CVSIGNORE };
  try {
    const home = path.join(f.base, "home"); await fs.mkdir(home); process.env.HOME = home; delete process.env.CVSIGNORE;
    const chars = [...Array.from({ length: 95 }, (_, i) => String.fromCharCode(i + 32)).filter(char => char !== "/" && char !== "\\"), "é", "中"];
    // 名字带码位，大小写不敏感的文件系统（macOS）上 a 与 A 不会落成同一个文件。
    const names = chars.map(char => `probe-${char}-${char.codePointAt(0)}.case`);
    for (const name of names) await fs.writeFile(path.join(f.wc, name), "1\n");
    const alpha = char => /[A-Za-z]/.test(char), digit = char => /[0-9]/.test(char);
    const classes = {
      alpha, digit, alnum: char => alpha(char) || digit(char), upper: char => /[A-Z]/.test(char), lower: char => /[a-z]/.test(char),
      space: char => " \t\n\r\f\v".includes(char), blank: char => " \t".includes(char),
      punct: char => char.charCodeAt(0) >= 33 && char.charCodeAt(0) <= 126 && !alpha(char) && !digit(char),
      xdigit: char => /[0-9A-Fa-f]/.test(char), cntrl: char => char.charCodeAt(0) <= 31 || char.charCodeAt(0) === 127,
      print: char => char.charCodeAt(0) >= 32 && char.charCodeAt(0) <= 126,
      graph: char => char.charCodeAt(0) >= 33 && char.charCodeAt(0) <= 126,
    };
    const cases = Object.entries(classes).map(([name, matches]) => [`[[:${name}:]]`, matches]);
    cases.push(
      ["[![:digit:]]", char => !digit(char)], ["[^[:alpha:]]", char => !alpha(char)],
      ["[[:alpha:]_]", char => alpha(char) || char === "_"], ["[a-c[:digit:]]", char => /[a-c0-9]/.test(char)],
      ["[[:upper:][:digit:]]", char => /[A-Z0-9]/.test(char)], ["[[:punct:]x]", char => classes.punct(char) || char === "x"],
      ["[[:digit:]\\-]", char => digit(char) || char === "-"],
      ["[][:digit:]]", char => digit(char) || char === "]"],
      ["[[:unknown:]]", () => false], ["[![:unknown:]]", () => false],
      ["[a[:unknown:]b]", char => char === "a"], ["[[:unknown:]a]", () => false],
      ["[!a[:unknown:]b]", () => false], ["[[:alpha:][:unknown:]]", alpha],
    );
    // macOS 上 Homebrew CVS 1.12.13 对方括号里的 \] 与 Linux 不同（[A\]] 只忽略 ]），该例只在 Linux 与真实 CVS 对照。
    if (process.platform !== "darwin") cases.push(["[[:alpha:]\\]]", char => alpha(char) || char === "]"]);
    const unknown = items => items.filter(item => item.state === "Unknown").map(item => item.newPath).sort();
    for (const [bracket, matches] of cases) {
      const pattern = `probe-${bracket}${bracket.startsWith("[!") || bracket.startsWith("[^") ? "*" : "-*"}.case`;
      await fs.writeFile(path.join(f.wc, ".cvsignore"), `${pattern}\n`);
      const expected = [".cvsignore", ...names.filter((_, index) => !matches(chars[index]))].sort();
      const { stdout } = await promisify(execFile)(f.process.executable, ["-f", "-n", "-q", "update"], { cwd: f.wc, env: { ...process.env, LC_ALL: "C" } });
      const actualCvs = stdout.split("\n").filter(line => line.startsWith("? ")).map(line => line.slice(2)).sort();
      assert.deepEqual(actualCvs, expected, `${pattern}: CVS differs from the C locale expectation`);
      assert.deepEqual(unknown(await f.cvs.localStatus()), expected, `${pattern}: local inventory differs from CVS`);
      assert.deepEqual(unknown(await f.cvs.localStatus([".cvsignore", ...names])), expected, `${pattern}: per-file refresh differs from CVS`);
      assert.deepEqual(unknown(await f.cvs.status()), expected, `${pattern}: network refresh differs from CVS`);
    }
    // C0 名字被路径合同拒绝；先由 cntrl/space/blank 过滤，再验证全量清单，不能调用单文件写入口。
    for (const [name, codes] of [["cntrl", [...Array.from({ length: 31 }, (_, i) => i + 1), 127]], ["space", [9, 10, 11, 12, 13]], ["blank", [9]]]) {
      const controls = codes.map(code => `control-${String.fromCharCode(code)}.case`);
      for (const file of controls) await fs.writeFile(path.join(f.wc, file), "1\n");
      await fs.writeFile(path.join(f.wc, ".cvsignore"), `control-[[:${name}:]].case\n`);
      assert.ok((await f.cvs.localStatus()).every(item => !controls.includes(item.newPath)), name);
      for (const file of controls) await fs.rm(path.join(f.wc, file));
    }
  } finally {
    for (const [key, value] of Object.entries(saved)) if (value === undefined) delete process.env[key]; else process.env[key] = value;
    await fs.rm(f.base, { recursive: true, force: true });
  }
});
// 服务器端 rlog／checkout -p 与 update 的命令：只记录，用来断言没有别的命令。
function recorded(f, wc = f.wc) {
  const runs = [];
  return { runs, adapter: new CvsAdapter(wc, { executable: f.process.executable, run: (...args) => { runs.push(args[0]); return f.process.run(...args); } }) };
}
const serverCommand = args => args[2];
test("temporary local CVS: repository log of an unsynchronized working copy covers new directories, Attic files and MS932, and reads revisions from the server", async () => {
  const f = await fixture();
  try {
    const peer = await checkout(f.process, f.root, "demo", path.join(f.base, "peer")), other = new CvsAdapter(peer, f.process);
    const pause = () => new Promise(done => setTimeout(done, 1100));
    // 修订时间只到秒：每次提交前停一下，保证与导入、前一次提交不在同一秒，列表顺序才确定。
    await pause();
    // 提交一：改两个文件并新增一个，一次 cvs commit 共用一个 commitid。
    await fs.writeFile(path.join(peer, "中文 file.txt"), "edited by colleague\n"); await fs.writeFile(path.join(peer, "other.txt"), "edited other\n");
    await fs.writeFile(path.join(peer, "fresh.txt"), "fresh\n"); await other.add(["fresh.txt"]);
    await other.commit(["中文 file.txt", "other.txt", "fresh.txt"], "peer: three files");
    await pause();
    // 提交二：新增后删除一个文件（进入服务器的 Attic），本地工作副本从未见过它。
    await fs.writeFile(path.join(peer, "gone.txt"), "gone\n"); await other.add(["gone.txt"]); await other.commit(["gone.txt"], "peer: add gone");
    await pause();
    await fs.rm(path.join(peer, "gone.txt")); await other.commit(["gone.txt"], "peer: remove gone");
    await pause();
    // 提交三：新建多层目录，本地没有这些目录，也不在 CVS/Entries 里。
    const created = ["newdir/top.txt", "newdir/sub/deep/n.txt"];
    await fs.mkdir(path.join(peer, "newdir/sub/deep"), { recursive: true });
    await other.add(["newdir", "newdir/sub", "newdir/sub/deep"]);
    for (const name of created) await fs.writeFile(path.join(peer, name), `${name}\n`);
    await other.add(created); await other.commit(created, "peer: new directories");
    await pause();
    // 提交四：说明为 MS932 字节。
    await fs.writeFile(path.join(peer, "中文 file.txt"), "edited twice\n");
    const message = path.join(f.base, "message.txt"); await fs.writeFile(message, Buffer.from("93fa967b8cea82cc90e096be", "hex"));
    await f.process.run(["commit", "-F", message, "中文 file.txt"], peer);

    const { runs, adapter } = recorded(f);
    // 本地工作副本没有更新：没有 newdir，Entries 里没有 fresh.txt 与 gone.txt。
    await assert.rejects(fs.access(path.join(f.wc, "newdir")));
    const revisions = await adapter.repositoryLog({});
    assert.equal(runs.length, 1, "repository log is one server command");
    assert.deepEqual([runs[0][0], runs[0][1].startsWith(":local:"), ...runs[0].slice(2)], ["-d", true, "rlog", "-N", "-S", "demo"]);
    const commits = groupCommits(revisions), by = (text) => commits.find(commit => commit.message === text);
    assert.deepEqual(commits.map(commit => commit.message), ["日本語の説明", "peer: new directories", "peer: remove gone", "peer: add gone", "peer: three files", "initial"]);
    assert.deepEqual(by("peer: new directories").files.map(file => `${file.path} ${file.kind} ${file.revision}`), ["newdir/sub/deep/n.txt added 1.1", "newdir/top.txt added 1.1"]);
    assert.deepEqual(by("peer: three files").files.map(file => `${file.path} ${file.previous ?? "-"}>${file.revision} ${file.kind}`), ["fresh.txt ->1.1 added", "other.txt 1.1>1.2 modified", "中文 file.txt 1.1>1.2 modified"]);
    // 已删除（Attic）的文件：路径还原，dead 修订显示为删除。
    assert.deepEqual(by("peer: remove gone").files.map(file => `${file.path} ${file.previous}>${file.revision} ${file.kind}`), ["gone.txt 1.1>1.2 deleted"]);
    assert.deepEqual(by("initial").files.map(file => `${file.path} ${file.revision} ${file.kind}`), ["other.txt 1.1 added", "中文 file.txt 1.1 added"]);
    assert.equal(by("日本語の説明").files[0].revision, "1.3");

    // 本地有没有：新建目录和新增文件本地没有，已有文件有。
    assert.deepEqual([...await adapter.localFiles(["newdir/top.txt", "fresh.txt", "other.txt", "中文 file.txt"])].sort(), ["other.txt", "中文 file.txt"].sort());

    // -d：只取最近几次提交；上界与下界相接的窗口合并后得到完整列表。
    const removed = revisions.filter(item => item.message === "peer: remove gone")[0].time;
    const since = await adapter.repositoryLog({ from: removed });
    assert.deepEqual(groupCommits(since).map(commit => commit.message), ["日本語の説明", "peer: new directories", "peer: remove gone"]);
    assert.deepEqual(runs.at(-1).slice(2, 5), ["rlog", "-N", "-S"]);
    assert.equal(runs.at(-1)[5], "-d");
    assert.match(runs.at(-1)[6], /^>=\d{4}-\d\d-\d\d \d\d:\d\d:\d\d \+0000$/);
    const older = await adapter.repositoryLog({ to: removed - 1000 });
    assert.deepEqual(groupCommits(older).map(commit => commit.message), ["peer: add gone", "peer: three files", "initial"]);

    // 单文件历史与修订内容：不在本地的文件、本地没有目录的文件、已删除（Attic）的文件，都向服务器取。
    assert.ok((await adapter.log("fresh.txt")).some(item => item.revisionId === "1.1"));
    assert.equal((await adapter.content("fresh.txt", "1.1")).toString(), "fresh\n");
    assert.equal((await adapter.content("newdir/sub/deep/n.txt", "1.1")).toString(), "newdir/sub/deep/n.txt\n");
    assert.equal((await adapter.log("gone.txt")).find(item => item.revisionId === "1.2").state, "dead");
    const before = runs.length;
    assert.equal((await adapter.content("gone.txt", "1.2")).length, 0);
    assert.equal(runs.slice(before).some(args => args[2] === "checkout"), false, "a dead revision is empty without fetching content");
    assert.equal((await adapter.content("gone.txt", "1.1")).toString(), "gone\n");
    // 只有 rlog 与 checkout -p：没有 update，没有 -n，没有 log。
    assert.ok(runs.every(args => ["rlog", "checkout"].includes(args[2])), JSON.stringify(runs.map(args => args[2])));
    assert.ok(runs.filter(args => args[2] === "checkout").every(args => args[3] === "-p" && args[4] === "-r"));
    assert.ok(!runs.some(args => args.includes("-n") || args.includes("update")));
    // 路径仍须在本工作副本内。
    await assert.rejects(adapter.log("../escape.txt"), { code: "path" });
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});
test("temporary local CVS: a working copy on a branch logs that branch with -r", async () => {
  const f = await fixture();
  try {
    await f.process.run(["tag", "-b", "BR1"], f.wc);
    await f.process.run(["update", "-r", "BR1"], f.wc);
    assert.equal((await fs.readFile(path.join(f.wc, "CVS", "Tag"), "utf8")).trim(), "TBR1");
    const onBranch = await checkout(f.process, f.root, "demo", path.join(f.base, "branch-peer"));
    await f.process.run(["update", "-r", "BR1"], onBranch);
    await fs.writeFile(path.join(onBranch, "other.txt"), "branch edit\n");
    await new CvsAdapter(onBranch, f.process).commit(["other.txt"], "on branch");
    const trunk = await checkout(f.process, f.root, "demo", path.join(f.base, "trunk-peer"));
    await fs.writeFile(path.join(trunk, "other.txt"), "trunk edit\n");
    await new CvsAdapter(trunk, f.process).commit(["other.txt"], "on trunk");
    const { runs, adapter } = recorded(f);
    const revisions = await adapter.repositoryLog({});
    assert.deepEqual(revisions.map(item => `${item.path}@${item.revision} ${item.message}`), ["other.txt@1.1.1.1.2.1 on branch"]);
    assert.ok(runs[0].includes("-rBR1"), JSON.stringify(runs[0]));
    // 单文件历史不受分支限制，仍是全部修订。
    assert.ok((await adapter.log("other.txt")).length >= 3);
  } finally { await fs.rm(f.base, { recursive: true, force: true }); }
});
test("temporary local CVS: update fetches directories the server created, without entering local directories that are not registered", async () => {
  const f = await fixture();
  try {
    const peer = await checkout(f.process, f.root, "demo", path.join(f.base, "peer")), other = new CvsAdapter(peer, f.process);
    // 本地：一个未登记的普通目录与一个异 Root 的检出，名字与服务器上即将新建的目录相同。
    const foreignRoot = path.join(f.base, "foreign-repo"), foreignSeed = path.join(f.base, "foreign-seed");
    await fs.mkdir(foreignRoot); await fs.mkdir(foreignSeed);
    await f.process.run(["-d", `:local:${foreignRoot}`, "init"], f.base);
    await fs.writeFile(path.join(foreignSeed, "o.txt"), "foreign\n");
    await f.process.run(["-d", `:local:${foreignRoot}`, "import", "-m", "foreign", "fmod", "v", "s"], foreignSeed);
    await checkout(f.process, `:local:${foreignRoot}`, "fmod", path.join(f.wc, "clash-foreign"));
    await fs.mkdir(path.join(f.wc, "clash-plain")); await fs.writeFile(path.join(f.wc, "clash-plain", "local.txt"), "mine\n");
    for (const name of ["clash-foreign/dropped.txt"]) void name;
    // 同事：新建多层目录并提交；另有与本地两个目录同名的新目录。
    const files = ["n1/top.txt", "n1/n2/mid.txt", "n1/n2/n3/deep.txt", "clash-foreign/s.txt", "clash-plain/s.txt"];
    for (const dir of ["n1", "n1/n2", "n1/n2/n3", "clash-foreign", "clash-plain"]) await fs.mkdir(path.join(peer, dir), { recursive: true });
    await other.add(["n1", "n1/n2", "n1/n2/n3", "clash-foreign", "clash-plain"]);
    for (const name of files) await fs.writeFile(path.join(peer, name), `${name}\n`);
    await other.add(files); await other.commit(files, "peer: new directories");
    // 本地已修改的文件更新后不能被覆盖。
    await fs.writeFile(path.join(f.wc, "other.txt"), "my local edit\n");

    const { runs, adapter } = recorded(f);
    await adapter.update();
    // 新目录整棵取下，空目录仍按 -P 修剪；元数据登记在父 Entries 里。
    for (const name of files.slice(0, 3)) assert.equal(await fs.readFile(path.join(f.wc, name), "utf8"), `${name}\n`);
    const registered = (await fs.readFile(path.join(f.wc, "CVS", "Entries"), "utf8")) + (await fs.readFile(path.join(f.wc, "CVS", "Entries.Log"), "utf8").catch(() => ""));
    assert.match(registered, /D\/n1\//);
    // 本地已有的同名目录一律不碰：未登记的普通目录保持原样，异 Root 检出的元数据与内容不变。
    assert.deepEqual(await fs.readdir(path.join(f.wc, "clash-plain")), ["local.txt"]);
    assert.equal((await fs.readFile(path.join(f.wc, "clash-foreign", "CVS", "Root"), "utf8")).trim(), `:local:${foreignRoot}`);
    assert.deepEqual((await fs.readdir(path.join(f.wc, "clash-foreign"))).sort(), ["CVS", "o.txt"]);
    // 本地修改的文件保持原样（不被覆盖）。
    assert.equal(await fs.readFile(path.join(f.wc, "other.txt"), "utf8"), "my local edit\n");
    // 命令：本地目录批次、服务器端查新目录、只对新目录的 update -d -P；没有对已登记目录的递归 -d，没有 -n。
    assert.deepEqual(runs.map(args => args[0] === "-d" ? args[2] : args.slice(0, 4).join(" ")), ["-q update -l -P", "rlog", "-q update -d -P"]);
    assert.deepEqual(runs.at(-1), ["-q", "update", "-d", "-P", "n1"]);
    // 新目录里的文件：本地更改里是干净的，日志的“本地”判断为有。
    const states = await adapter.localStatus();
    assert.deepEqual(states.filter(item => item.newPath.startsWith("n1/")).map(item => [item.newPath, item.state]).sort(), files.slice(0, 3).map(name => [name, "Up-to-date"]).sort());
    assert.deepEqual([...await adapter.localFiles(files.slice(0, 3))].sort(), files.slice(0, 3).sort());
    // 再更新一次：没有新目录就没有 update -d。
    runs.length = 0; await adapter.update();
    assert.ok(runs.every(args => !args.includes("-d") || args[0] === "-d"), JSON.stringify(runs));
    assert.ok(!runs.some(args => args[0] === "-q" && args.includes("-d")));
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
