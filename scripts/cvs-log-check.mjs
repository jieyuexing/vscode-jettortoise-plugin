/*
 * 仓库级 cvs log 的解析与分组：只用合成日志文本，不连任何 CVS。
 * 输出格式取自 CVS 1.12.13（日期带时区）与 1.11 一类旧版本（`YYYY/MM/DD` UTC）。
 */
import test from "node:test";
import assert from "node:assert/strict";
import {
  COMMIT_WINDOW_SECONDS,
  groupCommits,
  logRangeArgs,
  mergeRevisions,
  parseRepositoryLog,
  previousRevision,
  rlogPath,
  uniqueRevisions,
} from "../src/cvs/log.mjs";

const DASH = "-".repeat(28);
const EQUALS = "=".repeat(77);
/** 一个文件的 cvs log 输出块；revisions 的元素是 {rev, date, author, state, lines, commitid, branches, message(Buffer|string)}。 */
function fileBlock(name, revisions, { attic = false } = {}) {
  const rcs = attic ? name.replace(/([^/]+)$/, "Attic/$1") : name;
  const head = Buffer.from(
    `RCS file: /cvsroot/demo/${rcs},v\nhead: ${revisions[0].rev}\nbranch:\nlocks: strict\naccess list:\nkeyword substitution: kv\ntotal revisions: ${revisions.length};\tselected revisions: ${revisions.length}\ndescription:\n`,
    "latin1",
  );
  const parts = [head];
  for (const r of revisions) {
    const fields = [`date: ${r.date}`, `author: ${r.author ?? "dev-a"}`, `state: ${r.state ?? "Exp"}`];
    if (r.lines) fields.push(`lines: ${r.lines}`);
    if (r.commitid) fields.push(`commitid: ${r.commitid}`);
    parts.push(
      Buffer.from(`${DASH}\nrevision ${r.rev}\n${fields.join(";  ")};\n${r.branches ? `branches:  ${r.branches};\n` : ""}`, "latin1"),
      Buffer.isBuffer(r.message) ? r.message : Buffer.from(r.message, "utf8"),
      Buffer.from("\n", "latin1"),
    );
  }
  parts.push(Buffer.from(`${EQUALS}\n`, "latin1"));
  return Buffer.concat(parts);
}
/** 与真实输出一致：开头一个空行，文件块之间一个空行。 */
const toPath = (rcs) => rlogPath(rcs, "/cvsroot", "demo");
const output = (...blocks) => Buffer.concat([Buffer.from("\n"), ...blocks.flatMap((block, index) => (index ? [Buffer.from("\n"), block] : [block]))]);
const rev = (path, revision, date, extra = {}) => ({
  path,
  revision,
  time: Date.parse(date),
  author: "dev-a",
  state: "Exp",
  commitId: undefined,
  message: "message",
  ...extra,
});
// MS932 的「日本語の説明」。
const MS932 = Buffer.from("93fa967b8cea82cc90e096be", "hex");

test("parseRepositoryLog: several files, both date styles, Attic paths, dead, branch revisions, multi-line messages", () => {
  const parsed = parseRepositoryLog(
    output(
      fileBlock(
        "src/A.java",
        [
          { rev: "1.8", date: "2026-10-28 17:02:03 +0900", author: "dev-a", lines: "+3 -1", commitid: "c1c1c1c1c1c1c1c1", message: "first line\nsecond line\n\nlast" },
          { rev: "1.7", date: "2026/10/21 10:15:00", author: "dev-b", message: "older" },
        ],
      ),
      fileBlock("src/B.java", [
        { rev: "1.3", date: "2026-10-28 17:02:04 +0900", state: "dead", commitid: "c1c1c1c1c1c1c1c1", message: "same commit" },
        { rev: "1.1", date: "2026-10-20 08:00:00 +0900", branches: "1.1.1", message: "Initial revision" },
        { rev: "1.1.1.1", date: "2026-10-20 08:00:00 +0900", lines: "+0 -0", message: "vendor import" },
      ]),
      // 已删除的文件在服务器上位于 Attic/ 下：路径要还原成原来的位置。
      fileBlock("src/gone/C.java", [{ rev: "1.2", date: "2026-10-22 08:00:00 +0900", state: "dead", message: "removed" }], { attic: true }),
    ),
    toPath,
  );
  assert.deepEqual(
    parsed.map((item) => [item.path, item.revision, item.state, item.author, item.commitId, new Date(item.time).toISOString()]),
    [
      ["src/A.java", "1.8", "Exp", "dev-a", "c1c1c1c1c1c1c1c1", "2026-10-28T08:02:03.000Z"],
      ["src/A.java", "1.7", "Exp", "dev-b", undefined, "2026-10-21T10:15:00.000Z"],
      ["src/B.java", "1.3", "dead", "dev-a", "c1c1c1c1c1c1c1c1", "2026-10-28T08:02:04.000Z"],
      ["src/B.java", "1.1", "Exp", "dev-a", undefined, "2026-10-19T23:00:00.000Z"],
      ["src/B.java", "1.1.1.1", "Exp", "dev-a", undefined, "2026-10-19T23:00:00.000Z"],
      ["src/gone/C.java", "1.2", "dead", "dev-a", undefined, "2026-10-21T23:00:00.000Z"],
    ],
  );
  assert.equal(parsed[0].message, "first line\nsecond line\n\nlast");
  // branches: 行不是说明的一部分。
  assert.equal(parsed[3].message, "Initial revision");
});

test("parseRepositoryLog: a file with no selected revision (without -S) and an empty output yield nothing", () => {
  const empty = Buffer.from(
    `RCS file: /cvsroot/demo/old.txt,v\nhead: 1.1\nbranch:\nlocks: strict\naccess list:\nkeyword substitution: kv\ntotal revisions: 1;\tselected revisions: 0\ndescription:\n${EQUALS}\n`,
    "latin1",
  );
  assert.deepEqual(parseRepositoryLog(output(empty, fileBlock("new.txt", [{ rev: "1.2", date: "2026-11-01 10:00:00 +0000", message: "kept" }])), toPath).map((item) => item.path), ["new.txt"]);
  assert.deepEqual(parseRepositoryLog(Buffer.alloc(0), toPath), []);
  assert.deepEqual(parseRepositoryLog(output(empty), toPath), []);
});

test("parseRepositoryLog: MS932 and UTF-8 messages in one output are decoded one by one", () => {
  const parsed = parseRepositoryLog(
    output(
      fileBlock("jp.txt", [
        { rev: "1.2", date: "2026-11-01 10:00:00 +0000", message: Buffer.concat([MS932, Buffer.from(" ms932")]) },
        { rev: "1.1", date: "2026-10-01 10:00:00 +0000", message: "日本語の説明 utf8" },
      ]),
      fileBlock("x.txt", [{ rev: "1.1", date: "2026-10-01 10:00:00 +0000", message: Buffer.concat([MS932, Buffer.from("\nsecond line")]) }]),
    ),
    toPath,
  );
  assert.equal(parsed[0].message, "日本語の説明 ms932");
  assert.equal(parsed[1].message, "日本語の説明 utf8");
  assert.equal(parsed[2].message, "日本語の説明\nsecond line");
});

test("previousRevision follows revision arithmetic and branch points", () => {
  assert.equal(previousRevision("1.8"), "1.7");
  assert.equal(previousRevision("1.1"), undefined);
  assert.equal(previousRevision("1.4.2.1"), "1.4");
  assert.equal(previousRevision("1.4.2.3"), "1.4.2.2");
  assert.equal(previousRevision("1.1.1.1"), "1.1");
});

test("groupCommits: commitid keeps files of one commit together even when their times differ", () => {
  const commits = groupCommits([
    rev("a.txt", "1.2", "2026-10-28T08:00:00Z", { commitId: "k1", message: "one" }),
    rev("b.txt", "1.5", "2026-10-28T08:00:03Z", { commitId: "k1", message: "one" }),
    rev("c.txt", "1.1", "2026-10-28T08:09:00Z", { commitId: "k1", message: "one" }),
    // 同作者同说明同一秒，但 commitid 不同 → 两个提交。
    rev("d.txt", "1.2", "2026-10-29T08:00:00Z", { commitId: "k2", message: "same" }),
    rev("e.txt", "1.2", "2026-10-29T08:00:00Z", { commitId: "k3", message: "same" }),
  ]);
  assert.deepEqual(commits.map((commit) => [commit.id, commit.files.length]), [["k2", 1], ["k3", 1], ["k1", 3]]);
  const one = commits.find((commit) => commit.id === "k1");
  assert.equal(one.message, "one");
  assert.equal(one.author, "dev-a");
  assert.equal(one.time, Date.parse("2026-10-28T08:09:00Z"));
});

test(`groupCommits without commitid: ${COMMIT_WINDOW_SECONDS}s window, same author and message`, () => {
  assert.equal(COMMIT_WINDOW_SECONDS, 60);
  const at = (seconds) => new Date(Date.parse("2026-10-28T08:00:00Z") + seconds * 1000).toISOString();
  const ids = (revisions) => groupCommits(revisions).map((commit) => commit.files.map((file) => file.path).sort().join(","));
  // 链式：相邻两个修订相差不超过 60 秒即同组。
  assert.deepEqual(ids([rev("a", "1.2", at(0)), rev("b", "1.2", at(60)), rev("c", "1.2", at(120))]), ["a,b,c"]);
  // 61 秒另起一组。
  assert.deepEqual(ids([rev("a", "1.2", at(0)), rev("b", "1.2", at(61))]), ["b", "a"]);
  // 说明不同、作者不同都拆开。
  assert.deepEqual(ids([rev("a", "1.2", at(0)), rev("b", "1.2", at(1), { message: "other" })]), ["b", "a"]);
  assert.deepEqual(ids([rev("a", "1.2", at(0)), rev("b", "1.2", at(1), { author: "dev-b" })]), ["b", "a"]);
  // 同一文件不会在一个提交里出现两次：第二次修订另起一组。
  const twice = groupCommits([rev("a", "1.2", at(0)), rev("a", "1.3", at(5))]);
  assert.deepEqual(twice.map((commit) => commit.files.map((file) => `${file.path} ${file.revision}`)), [["a 1.3"], ["a 1.2"]]);
  // 无 commitid 的修订不会并进有 commitid 的提交，两种混排互不影响。
  const mixed = groupCommits([rev("a", "1.2", at(0), { commitId: "k" }), rev("b", "1.2", at(1))]);
  assert.deepEqual(mixed.map((commit) => commit.files.length), [1, 1]);
});

test("groupCommits: added, modified and deleted files carry the revision change", () => {
  const [commit] = groupCommits([
    rev("src/New.java", "1.1", "2026-10-28T08:00:00Z", { commitId: "k" }),
    rev("src/Edit.java", "1.8", "2026-10-28T08:00:00Z", { commitId: "k" }),
    rev("src/Gone.java", "1.4", "2026-10-28T08:00:00Z", { commitId: "k", state: "dead" }),
    rev("src/Branch.java", "1.4.2.1", "2026-10-28T08:00:00Z", { commitId: "k" }),
  ]);
  const byPath = Object.fromEntries(commit.files.map((file) => [file.path, file]));
  assert.deepEqual(byPath["src/New.java"], { path: "src/New.java", revision: "1.1", previous: undefined, kind: "added" });
  assert.deepEqual(byPath["src/Edit.java"], { path: "src/Edit.java", revision: "1.8", previous: "1.7", kind: "modified" });
  assert.deepEqual(byPath["src/Gone.java"], { path: "src/Gone.java", revision: "1.4", previous: "1.3", kind: "deleted" });
  assert.deepEqual(byPath["src/Branch.java"], { path: "src/Branch.java", revision: "1.4.2.1", previous: "1.4", kind: "modified" });
  assert.deepEqual(commit.files.map((file) => file.path), [...commit.files.map((file) => file.path)].sort((a, b) => a.localeCompare(b)));
});

test("groupCommits: an import (1.1 and 1.1.1.1 share the commitid) is one added file per path with the import message", () => {
  const [commit] = groupCommits([
    rev("a.txt", "1.1", "2026-10-20T08:00:00Z", { commitId: "imp", message: "Initial revision" }),
    rev("a.txt", "1.1.1.1", "2026-10-20T08:00:00Z", { commitId: "imp", message: "import sample project" }),
    rev("b.txt", "1.1", "2026-10-20T08:00:00Z", { commitId: "imp", message: "Initial revision" }),
    rev("b.txt", "1.1.1.1", "2026-10-20T08:00:00Z", { commitId: "imp", message: "import sample project" }),
  ]);
  assert.equal(commit.message, "import sample project");
  assert.deepEqual(commit.files.map((file) => [file.path, file.revision, file.kind]), [["a.txt", "1.1", "added"], ["b.txt", "1.1", "added"]]);
});

test("groupCommits: an import on a server without commitid is still one commit with the import message", () => {
  const [commit, ...rest] = groupCommits([
    rev("a.txt", "1.1", "2026-10-20T08:00:00Z", { message: "Initial revision" }),
    rev("a.txt", "1.1.1.1", "2026-10-20T08:00:00Z", { message: "import sample project" }),
    rev("b.txt", "1.1", "2026-10-20T08:00:00Z", { message: "Initial revision" }),
    rev("b.txt", "1.1.1.1", "2026-10-20T08:00:00Z", { message: "import sample project" }),
  ]);
  assert.equal(rest.length, 0);
  assert.equal(commit.message, "import sample project");
  assert.deepEqual(commit.files.map((file) => [file.path, file.revision, file.kind]), [["a.txt", "1.1", "added"], ["b.txt", "1.1", "added"]]);
  // 不同作者或不同时刻的 1.1.1.1 不是孪生：两条各自成行。
  assert.equal(groupCommits([rev("a.txt", "1.1", "2026-10-20T08:00:00Z"), rev("a.txt", "1.1.1.1", "2026-10-20T09:00:00Z")]).length, 2);
});

test("groupCommits: the dead 1.1 left by cvs add on a branch is not a deletion", () => {
  const commits = groupCommits([
    rev("branch-only.txt", "1.1", "2026-10-28T08:00:00Z", { state: "dead", message: "file branch-only.txt was initially added on branch feature." }),
    rev("branch-only.txt", "1.1.2.1", "2026-10-28T08:00:01Z", { message: "add on branch" }),
  ]);
  assert.deepEqual(commits.map((commit) => commit.files.map((file) => `${file.revision} ${file.kind}`)), [["1.1.2.1 modified"]]);
});

test("groupCommits: newest first, id is the commitid or a stable synthetic key", () => {
  const input = [
    rev("a", "1.2", "2026-10-01T08:00:00Z", { message: "old" }),
    rev("b", "1.2", "2026-10-03T08:00:00Z", { commitId: "newest", message: "new" }),
    rev("c", "1.2", "2026-10-02T08:00:00Z", { message: "mid" }),
  ];
  const commits = groupCommits(input);
  assert.deepEqual(commits.map((commit) => commit.message), ["new", "mid", "old"]);
  assert.equal(commits[0].id, "newest");
  assert.ok(commits[1].id && commits[1].id !== commits[2].id);
  assert.deepEqual(groupCommits([...input].reverse()).map((commit) => commit.id), commits.map((commit) => commit.id));
});

test("logRangeArgs builds the cvs log -d range in UTC; mergeRevisions drops duplicates of the overlapping second", () => {
  assert.deepEqual(logRangeArgs({}), []);
  assert.deepEqual(logRangeArgs({ from: Date.UTC(2026, 7, 12, 3, 0, 0) }), ["-d", ">=2026-08-12 03:00:00 +0000"]);
  assert.deepEqual(logRangeArgs({ to: Date.UTC(2026, 7, 12, 3, 0, 0) }), ["-d", "<=2026-08-12 03:00:00 +0000"]);
  assert.deepEqual(logRangeArgs({ from: Date.UTC(2026, 4, 14, 3, 0, 0), to: Date.UTC(2026, 7, 12, 3, 0, 0) }), ["-d", "2026-05-14 03:00:00 +0000<=2026-08-12 03:00:00 +0000"]);
  const a = rev("x", "1.2", "2026-08-12T03:00:00Z"), b = rev("x", "1.1", "2026-08-12T02:59:00Z");
  assert.deepEqual(mergeRevisions([a], [a, b]).map((item) => item.revision), ["1.2", "1.1"]);
});

test("uniqueRevisions keeps one entry per path@revision; parseRepositoryLog reports what the server sent", () => {
  const block = fileBlock("src/A.java", [{ rev: "1.2", date: "2026-10-28 17:02:03 +0900", message: "edit" }]);
  // 服务器把同一个文件重复输出多次（深层文件被每个祖先目录参数各取一次）。
  const repeated = parseRepositoryLog(output(block, block, block), toPath);
  assert.equal(repeated.length, 3);
  assert.deepEqual(uniqueRevisions(repeated).map((item) => `${item.path}@${item.revision}`), ["src/A.java@1.2"]);
  assert.deepEqual(uniqueRevisions([]), []);
});

test("groupCommits: one commit of six files over eight seconds is one row, with or without repeated output", () => {
  const at = (seconds) => new Date(Date.parse("2026-11-09T07:01:51Z") + seconds * 1000).toISOString();
  const message = "sample change";
  const six = ["a/b/c/d/E1.java", "a/b/c/d/E2.java", "a/b/c/d/E3.java", "a/b/c/d/E4.java", "a/b/c/d/E5.java", "a/b/c/d/E6.java"].map((path, index) => rev(path, "1.9", at(index === 5 ? 8 : index), { message }));
  const others = [rev("x/Other1.java", "1.4", at(-3600), { message: "other one", author: "dev-b" }), rev("x/Other2.java", "2.1", at(-7200), { message: "other two" })];
  const plain = groupCommits([...six, ...others]);
  assert.deepEqual(plain.map((commit) => commit.files.length), [6, 1, 1]);
  assert.equal(plain[0].message, message);
  // 每个文件被重复 11 次（目录层数）：仍然只有一个提交、六个文件。
  const repeated = groupCommits([...Array.from({ length: 11 }, () => six).flat(), ...others]);
  assert.deepEqual(repeated.map((commit) => commit.files.length), [6, 1, 1]);
});

test("rlogPath turns an RCS file into a path relative to the working copy root", () => {
  assert.equal(rlogPath("/cvsroot/demo/src/A.java,v", "/cvsroot", "demo"), "src/A.java");
  assert.equal(rlogPath("/cvsroot/demo/src/Attic/A.java,v", "/cvsroot", "demo"), "src/A.java");
  assert.equal(rlogPath("/cvsroot/demo/Attic/root.txt,v", "/cvsroot", "demo"), "root.txt");
  // 目录本身叫 Attic 之外的名字、或 Attic 不在最后一层时保持原样。
  assert.equal(rlogPath("/cvsroot/demo/Attic/sub/A.java,v", "/cvsroot", "demo"), "Attic/sub/A.java");
  // 工作副本根是模块的子目录。
  assert.equal(rlogPath("/cvsroot/mod/sub/dir/f.txt,v", "/cvsroot", "mod/sub"), "dir/f.txt");
  // Root 路径与服务器真实路径不一致（虚拟路径）时按模块前缀截取；不在该模块下则忽略。
  assert.equal(rlogPath("D:/repo/demo/src/A.java,v", "/cvsroot", "demo"), "src/A.java");
  assert.equal(rlogPath("/cvsroot/other/A.java,v", "/cvsroot", "demo"), undefined);
});
