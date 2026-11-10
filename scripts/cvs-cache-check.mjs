/*
 * 落盘缓存：键不含凭据、版本与损坏处理、修订内容按最近使用淘汰。只用临时目录，不连任何 CVS。
 */
import test from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { CACHE_VERSION, CvsCacheStore, rootIdentity, rootPath } from "../src/cvs/cache.mjs";

async function directory() {
  return fs.realpath(await fs.mkdtemp(path.join(tmpdir(), "jettortoise-cache-")));
}
const identity = (extra = {}) => ({ root: ":pserver:dev@cvs.example.invalid:2401/cvsroot", repository: "demo", branch: "", workingCopy: "/work/demo", ...extra });
const state = (extra = {}) => ({ coveredFrom: 0, newest: 5, fetchedAt: 10, revisions: [{ path: "a.txt", revision: "1.1", time: 5, author: "dev-a", state: "Exp", message: "m" }], ...extra });

test("rootIdentity keeps host and path only; rootPath is the repository path", () => {
  for (const [root, identityValue, base] of [
    [":pserver:dev@Cvs.Example.invalid:2401/cvsroot", "cvs.example.invalid/cvsroot", "/cvsroot"],
    [":pserver:dev@cvs.example.invalid:2401:/cvsroot", "cvs.example.invalid/cvsroot", "/cvsroot"],
    [":pserver:cvs.example.invalid:/cvsroot", "cvs.example.invalid/cvsroot", "/cvsroot"],
    [":local:/data/repo", "local:/data/repo", "/data/repo"],
    ["/data/repo", "local:/data/repo", "/data/repo"],
  ]) {
    assert.equal(rootIdentity(root), identityValue, root);
    assert.equal(rootPath(root), base, root);
  }
  assert.equal(rootIdentity(":pserver:dev@host:2401/r"), rootIdentity(":pserver:other@host:2402/r"));
});

test("log cache: round trip, key varies with repository, branch and working copy, no credentials on disk", async () => {
  const base = await directory();
  try {
    const store = new CvsCacheStore(base);
    const cache = store.repository(identity());
    assert.equal(await cache.readLog(), undefined);
    await cache.writeLog(state());
    assert.deepEqual(await store.repository(identity()).readLog(), { version: CACHE_VERSION, ...state() });
    for (const other of [{ branch: "TBR1" }, { repository: "other" }, { workingCopy: "/work/second" }, { root: ":pserver:dev@cvs.example.invalid:2401/other" }])
      assert.equal(await store.repository(identity(other)).readLog(), undefined, JSON.stringify(other));
    // 用户、口令、端口和路径都不出现在文件名或内容里。
    await cache.writeHistories({ "a.txt": { entryRevision: "1.1", fetchedAt: 1, revisions: [] } });
    await cache.writeContent("a.txt", "1.1", Buffer.from("content"));
    const names = [];
    for (const entry of await fs.readdir(base, { recursive: true, withFileTypes: true })) if (entry.isFile()) names.push(path.join(entry.parentPath, entry.name));
    assert.ok(names.length >= 3);
    for (const file of names) {
      const text = file + (await fs.readFile(file)).toString("latin1");
      assert.ok(!/dev@|2401|\/work\/demo/.test(text.replace(base, "")), `credentials or paths leaked into ${file}`);
    }
    assert.deepEqual(await cache.readHistories(), { "a.txt": { entryRevision: "1.1", fetchedAt: 1, revisions: [] } });
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("log cache: a different version, corrupt JSON or a malformed shape is discarded and read as missing", async () => {
  const base = await directory();
  try {
    const store = new CvsCacheStore(base), cache = store.repository(identity());
    for (const text of [JSON.stringify({ version: CACHE_VERSION + 1, ...state() }), "{not json", JSON.stringify({ version: CACHE_VERSION, ...state({ revisions: [{ path: 1 }] }) }), JSON.stringify({ version: CACHE_VERSION, ...state({ coveredFrom: "x" }) })]) {
      await fs.writeFile(cache.logFile, text);
      assert.equal(await cache.readLog(), undefined, text);
      await assert.rejects(fs.access(cache.logFile), "an unreadable cache file must be removed");
    }
    await fs.writeFile(cache.historyFile, "garbage");
    assert.deepEqual(await cache.readHistories(), {});
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("content cache: shared by working copies, immutable, least recently used entries are evicted above the limit", async () => {
  const base = await directory();
  try {
    const store = new CvsCacheStore(base, { contentLimit: 1000 });
    const first = store.repository(identity()), second = store.repository(identity({ workingCopy: "/work/second", branch: "TBR1" }));
    await first.writeContent("a.txt", "1.1", Buffer.alloc(200, 1));
    assert.deepEqual(await second.readContent("a.txt", "1.1"), Buffer.alloc(200, 1), "same revision is shared across working copies and branches");
    assert.equal(await first.readContent("a.txt", "1.2"), undefined);
    // 单个过大的内容不缓存。
    await first.writeContent("big.bin", "1.1", Buffer.alloc(400));
    assert.equal(await first.readContent("big.bin", "1.1"), undefined);
    // 写满：a 最近读过，b 最旧，应淘汰 b 等。
    await first.writeContent("b.txt", "1.1", Buffer.alloc(240, 2));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await first.writeContent("c.txt", "1.1", Buffer.alloc(240, 3));
    await new Promise((resolve) => setTimeout(resolve, 20));
    await first.readContent("a.txt", "1.1");
    await new Promise((resolve) => setTimeout(resolve, 20));
    await first.writeContent("d.txt", "1.1", Buffer.alloc(240, 4));
    await first.writeContent("e.txt", "1.1", Buffer.alloc(240, 5));
    let total = 0;
    for (const entry of await fs.readdir(path.join(base, "content"))) total += (await fs.stat(path.join(base, "content", entry))).size;
    assert.ok(total <= 1000, `content cache exceeds its limit: ${total}`);
    assert.ok(await first.readContent("e.txt", "1.1"), "the newest entry must survive");
    assert.ok(await first.readContent("a.txt", "1.1"), "a recently used entry must survive");
    assert.equal(await first.readContent("b.txt", "1.1"), undefined, "the least recently used entry must be evicted");
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});

test("clear removes everything", async () => {
  const base = await directory();
  try {
    const store = new CvsCacheStore(path.join(base, "cvs-cache")), cache = store.repository(identity());
    await cache.writeLog(state()); await cache.writeContent("a.txt", "1.1", Buffer.from("x"));
    await store.clear();
    assert.equal(await cache.readLog(), undefined);
    assert.equal(await cache.readContent("a.txt", "1.1"), undefined);
    await cache.writeContent("a.txt", "1.1", Buffer.from("x"));
    assert.ok(await cache.readContent("a.txt", "1.1"));
  } finally { await fs.rm(base, { recursive: true, force: true }); }
});
