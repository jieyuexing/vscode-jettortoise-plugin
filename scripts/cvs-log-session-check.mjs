/*
 * 仓库日志取数编排：范围覆盖、新鲜期、增量与失败处理。时间、取数与缓存全部注入，不连任何 CVS。
 */
import test from "node:test";
import assert from "node:assert/strict";
import { LOG_FRESH_MS, LOG_OVERLAP_MS } from "tortoise-core/cvs/cache";
import { DAY, loadRepositoryLog, needsFetch } from "tortoise-core/cvs/log-session";

const NOW = Date.parse("2026-11-10T12:00:00Z");
const rev = (path, revision, ageMs) => ({ path, revision, time: NOW - ageMs, author: "dev-a", state: "Exp", message: "m" });
const state = (extra = {}) => ({
  coveredFrom: NOW - 90 * DAY,
  newest: NOW - 2 * 60 * 60 * 1000,
  fetchedAt: NOW - 60 * 60 * 1000,
  revisions: [rev("a.txt", "1.1", 2 * 60 * 60 * 1000)],
  ...extra,
});
/** 记录每次取数范围与落盘写入；answers 按取数次序给出返回值，或抛出 Error。 */
function harness(answers = [], { disk, writeFails = false } = {}) {
  const calls = { fetch: [], writes: [], reads: 0 };
  return {
    calls,
    options: {
      now: () => NOW,
      fetchRevisions: async (range) => {
        calls.fetch.push(range);
        const answer = answers.shift() ?? [];
        if (answer instanceof Error) throw answer;
        return answer;
      },
      readLog: async () => {
        calls.reads += 1;
        return disk;
      },
      writeLog: async (next) => {
        calls.writes.push(next);
        if (writeFails) throw new Error("disk full");
      },
    },
  };
}

test("没有缓存：按范围取一次并落盘，最新时间取修订里的最大值", async () => {
  const { calls, options } = harness([[rev("a.txt", "1.2", 1000), rev("b.txt", "1.1", 5000)]]);
  const result = await loadRepositoryLog({ ...options, days: 30 });
  assert.deepEqual(calls.fetch, [{ from: NOW - 30 * DAY }]);
  assert.equal(result.contacted, true);
  assert.equal(result.refreshed, false);
  assert.deepEqual(
    { coveredFrom: result.state.coveredFrom, newest: result.state.newest, fetchedAt: result.state.fetchedAt },
    { coveredFrom: NOW - 30 * DAY, newest: NOW - 1000, fetchedAt: NOW },
  );
  assert.equal(calls.writes.length, 1);
});

test("没有缓存且取全部：不带起点，coveredFrom 为 0；没有修订时 newest 为 null", async () => {
  const { calls, options } = harness([[]]);
  const result = await loadRepositoryLog({ ...options, days: 0 });
  assert.deepEqual(calls.fetch, [{ from: undefined }]);
  assert.equal(result.state.coveredFrom, 0);
  assert.equal(result.state.newest, null);
});

test("没有缓存时取数失败：直接抛出，不落盘", async () => {
  const { calls, options } = harness([new Error("offline")]);
  await assert.rejects(loadRepositoryLog({ ...options, days: 30 }), /offline/);
  assert.equal(calls.writes.length, 0);
});

test("已覆盖且在新鲜期内：不连服务器、不读盘", async () => {
  const cached = state({ fetchedAt: NOW - (LOG_FRESH_MS - 1000) });
  const { calls, options } = harness();
  const result = await loadRepositoryLog({ ...options, state: cached, days: 30 });
  assert.deepEqual(calls.fetch, []);
  assert.equal(calls.reads, 0);
  assert.equal(result.contacted, false);
  assert.equal(result.state, cached);
});

test("新鲜期边界：恰好满 LOG_FRESH_MS 就取增量", async () => {
  const cached = state({ fetchedAt: NOW - LOG_FRESH_MS });
  const { calls, options } = harness([[]]);
  const result = await loadRepositoryLog({ ...options, state: cached, days: 30 });
  assert.equal(calls.fetch.length, 1);
  assert.equal(result.refreshed, true);
});

test("过了新鲜期：从最新缓存时间往回 LOG_OVERLAP_MS 取增量，按 path@revision 去重合并", async () => {
  const cached = state();
  const { calls, options } = harness([[rev("a.txt", "1.1", 2 * 60 * 60 * 1000), rev("a.txt", "1.2", 60 * 1000)]]);
  const result = await loadRepositoryLog({ ...options, state: cached, days: 30 });
  assert.deepEqual(calls.fetch, [{ from: cached.newest - LOG_OVERLAP_MS }]);
  assert.deepEqual(
    result.state.revisions.map((item) => `${item.path}@${item.revision}`).sort(),
    ["a.txt@1.1", "a.txt@1.2"],
  );
  assert.equal(result.state.newest, NOW - 60 * 1000);
  assert.equal(result.state.fetchedAt, NOW);
  assert.equal(result.state.coveredFrom, cached.coveredFrom);
  assert.equal(result.refreshed, true);
});

test("缓存没有修订（newest 为 null）：增量从 coveredFrom 起，覆盖全部时不带起点", async () => {
  for (const [coveredFrom, from] of [[NOW - 90 * DAY, NOW - 90 * DAY], [0, undefined]]) {
    const { calls, options } = harness([[]]);
    await loadRepositoryLog({
      ...options,
      state: state({ coveredFrom, newest: null, revisions: [], fetchedAt: 0 }),
      days: 30,
    });
    assert.deepEqual(calls.fetch, [{ from }]);
  }
});

test("refresh 与 stale 都强制取增量；stale 取过后 refreshed 通知调用方清除标记", async () => {
  for (const flag of ["refresh", "stale"]) {
    const { calls, options } = harness([[]]);
    const result = await loadRepositoryLog({ ...options, state: state({ fetchedAt: NOW - 1000 }), days: 30, [flag]: true });
    assert.equal(calls.fetch.length, 1, flag);
    assert.equal(result.refreshed, true, flag);
  }
});

test("范围比缓存更大：只取缺的那一段（起点到旧 coveredFrom，含两端），新鲜期内不再取增量", async () => {
  const cached = state({ fetchedAt: NOW - 1000 });
  const { calls, options } = harness([[rev("old.txt", "1.1", 120 * DAY)]]);
  const result = await loadRepositoryLog({ ...options, state: cached, days: 180 });
  assert.deepEqual(calls.fetch, [{ from: NOW - 180 * DAY, to: cached.coveredFrom }]);
  assert.equal(result.state.coveredFrom, NOW - 180 * DAY);
  assert.equal(result.state.revisions.length, 2);
  assert.equal(result.contacted, true);
  assert.equal(result.refreshed, false);
});

test("取全部而缓存只覆盖近 90 天：起点不带，补到 coveredFrom 为止", async () => {
  const cached = state({ fetchedAt: NOW - 1000 });
  const { calls, options } = harness([[]]);
  const result = await loadRepositoryLog({ ...options, state: cached, days: 0 });
  assert.deepEqual(calls.fetch, [{ from: undefined, to: cached.coveredFrom }]);
  assert.equal(result.state.coveredFrom, 0);
});

test("缓存已覆盖全部历史：任何范围都不再补更早的一段", async () => {
  const cached = state({ coveredFrom: 0, fetchedAt: NOW - 1000 });
  const { calls, options } = harness();
  await loadRepositoryLog({ ...options, state: cached, days: 0 });
  await loadRepositoryLog({ ...options, state: cached, days: 365 });
  assert.deepEqual(calls.fetch, []);
});

test("既缺更早一段又过期：先补更早，再取增量，共两次，增量基于补完后的状态", async () => {
  const cached = state({ fetchedAt: 0 });
  const { calls, options } = harness([[rev("old.txt", "1.1", 120 * DAY)], [rev("a.txt", "1.2", 1000)]]);
  const result = await loadRepositoryLog({ ...options, state: cached, days: 180 });
  assert.equal(calls.fetch.length, 2);
  assert.deepEqual(calls.fetch[1], { from: cached.newest - LOG_OVERLAP_MS });
  assert.equal(result.state.revisions.length, 3);
  assert.equal(calls.writes.length, 2);
});

test("别的窗口已更新过缓存：采用落盘的状态，不再连服务器", async () => {
  const cached = state({ fetchedAt: 0 });
  const disk = state({ fetchedAt: NOW - 1000, revisions: [rev("a.txt", "1.1", 2 * 60 * 60 * 1000), rev("c.txt", "1.1", 1000)] });
  const { calls, options } = harness([], { disk });
  const result = await loadRepositoryLog({ ...options, state: cached, days: 30 });
  assert.deepEqual(calls.fetch, []);
  assert.equal(result.state, disk);
  assert.equal(result.contacted, false);
});

test("落盘缓存更旧或覆盖更少：不采用，照常取增量", async () => {
  const cached = state({ fetchedAt: NOW - 10 * 60 * 1000 });
  const onlyOnDisk = rev("disk-only.txt", "1.1", 1000);
  for (const disk of [
    state({ fetchedAt: NOW - 20 * 60 * 1000, revisions: [onlyOnDisk] }),
    state({ fetchedAt: NOW - 1000, coveredFrom: NOW - 30 * DAY, revisions: [onlyOnDisk] }),
  ]) {
    const { calls, options } = harness([[]], { disk });
    const result = await loadRepositoryLog({ ...options, state: cached, days: 30 });
    assert.equal(calls.fetch.length, 1);
    assert.equal(result.state.revisions.some((item) => item.path === "disk-only.txt"), false);
  }
});

test("refresh 即使落盘缓存更新也取增量", async () => {
  const disk = state({ fetchedAt: NOW - 1000 });
  const { calls, options } = harness([[]], { disk });
  await loadRepositoryLog({ ...options, state: state({ fetchedAt: 0 }), days: 30, refresh: true });
  assert.equal(calls.fetch.length, 1);
});

test("有缓存时取数失败：不抛出，返回已有状态和错误；补更早已保存的部分保留", async () => {
  const cached = state({ fetchedAt: 0 });
  const { calls, options } = harness([[rev("old.txt", "1.1", 120 * DAY)], new Error("offline")]);
  const result = await loadRepositoryLog({ ...options, state: cached, days: 180 });
  assert.equal(result.error.message, "offline");
  assert.equal(result.contacted, true);
  assert.equal(result.refreshed, false);
  assert.equal(result.state.coveredFrom, NOW - 180 * DAY);
  assert.equal(result.state.fetchedAt, 0);
  assert.equal(calls.writes.length, 1);
});

test("落盘写入失败不影响结果", async () => {
  const { options } = harness([[rev("a.txt", "1.2", 1000)]], { writeFails: true });
  const result = await loadRepositoryLog({ ...options, state: state({ fetchedAt: 0 }), days: 30 });
  assert.equal(result.error, undefined);
  assert.equal(result.state.revisions.length, 2);
});

test("没有 readLog／writeLog 也能运行", async () => {
  const result = await loadRepositoryLog({
    now: () => NOW,
    fetchRevisions: async () => [rev("a.txt", "1.2", 1000)],
    state: state({ fetchedAt: 0 }),
    days: 30,
  });
  assert.equal(result.state.revisions.length, 2);
});

test("取数函数收到取消信号", async () => {
  const controller = new AbortController();
  let seen;
  await loadRepositoryLog({
    now: () => NOW,
    fetchRevisions: async (_range, signal) => {
      seen = signal;
      return [];
    },
    days: 30,
    signal: controller.signal,
  });
  assert.equal(seen, controller.signal);
});

test("needsFetch：无缓存、未覆盖、过期、refresh、stale 为真；已覆盖且新鲜为假", () => {
  const fresh = state({ fetchedAt: NOW - 1000 });
  const base = { days: 30, now: NOW };
  assert.equal(needsFetch(undefined, base), true);
  assert.equal(needsFetch(fresh, base), false);
  assert.equal(needsFetch(fresh, { ...base, days: 180 }), true);
  assert.equal(needsFetch(fresh, { ...base, days: 0 }), true);
  assert.equal(needsFetch(state({ coveredFrom: 0, fetchedAt: NOW - 1000 }), { ...base, days: 0 }), false);
  assert.equal(needsFetch(state({ fetchedAt: NOW - LOG_FRESH_MS }), base), true);
  assert.equal(needsFetch(fresh, { ...base, refresh: true }), true);
  assert.equal(needsFetch(fresh, { ...base, stale: true }), true);
});
