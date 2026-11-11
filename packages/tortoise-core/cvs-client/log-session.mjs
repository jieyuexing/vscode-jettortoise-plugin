// 仓库日志的取数编排：范围覆盖、新鲜期、增量与合并。时间、取数函数与缓存都由调用方注入，
// 不依赖 vscode，也不碰进程；JetTortoise 与 T3 插件共用这一份，界面各做各的。
import { LOG_FRESH_MS, LOG_OVERLAP_MS } from "./cache.mjs";
import { mergeRevisions } from "./log.mjs";

export const DAY = 24 * 60 * 60 * 1000;

/** 修订里最新的时间；没有修订为 null。 */
export function newestTime(revisions) {
  return revisions.reduce(
    (latest, item) =>
      latest === null || item.time > latest ? item.time : latest,
    null,
  );
}

/** 范围起点：近 days 天从 now 往回算，0 为全部（起点 0）。 */
export function rangeStart(days, now) {
  return days ? now - days * DAY : 0;
}

/** 缓存已覆盖到 needFrom 吗（coveredFrom 为 0 即全部历史）。 */
export function covers(state, needFrom) {
  return state.coveredFrom === 0 || needFrom >= state.coveredFrom;
}

/** 该做增量了吗：显式刷新、写入后标记过期，或距上次连服务器已超过新鲜期。 */
export function isStale(state, { refresh = false, stale = false, now }) {
  return refresh || stale || now - state.fetchedAt >= LOG_FRESH_MS;
}

/** 需要连服务器吗：没有缓存、缓存没覆盖到 days，或已过期。 */
export function needsFetch(
  state,
  { days, refresh = false, stale = false, now },
) {
  if (!state) return true;
  return (
    !covers(state, rangeStart(days, now)) ||
    isStale(state, { refresh, stale, now })
  );
}

/**
 * 按需取数并合并进缓存状态：
 * - 没有缓存：取 days 范围；
 * - 范围比缓存更大：只取缺的那一段（起点到 coveredFrom，含两端）；
 * - 过了新鲜期、refresh 或 stale：从最新缓存时间往回 LOG_OVERLAP_MS 取增量，按 path@revision 去重。
 * 有缓存时取数失败不抛出：返回已有（含已保存的部分）状态与 error，调用方决定如何提示；没有缓存时直接抛出。
 *
 * 注入：state 为内存里的缓存；fetchRevisions(range, signal) 取修订；readLog()／writeLog(state) 读写落盘缓存
 * （写入失败忽略）；now() 给出当前时间。
 * 返回 { state, contacted: 是否连过服务器, refreshed: 是否做了增量（调用方据此清除 stale）, error? }。
 */
export async function loadRepositoryLog({
  state,
  days,
  refresh = false,
  stale = false,
  now = Date.now,
  fetchRevisions,
  readLog,
  writeLog,
  signal,
}) {
  const start = now();
  const needFrom = rangeStart(days, start);
  let contacted = false;
  let refreshed = false;
  const save = async (next) => {
    state = next;
    await writeLog?.(next).catch(() => {});
  };
  if (!state) {
    const revisions = await fetchRevisions(
      { from: needFrom || undefined },
      signal,
    );
    await save({
      coveredFrom: needFrom,
      newest: newestTime(revisions),
      fetchedAt: now(),
      revisions,
    });
    return { state, contacted: true, refreshed };
  }
  try {
    if (!covers(state, needFrom)) {
      const older = await fetchRevisions(
        { from: needFrom || undefined, to: state.coveredFrom },
        signal,
      );
      await save({
        ...state,
        coveredFrom: needFrom,
        revisions: mergeRevisions(state.revisions, older),
      });
      contacted = true;
    }
    if (isStale(state, { refresh, stale, now: start })) {
      // 别的窗口可能已经更新过缓存：先取它的。
      const disk = await readLog?.();
      if (
        disk &&
        disk.fetchedAt > state.fetchedAt &&
        (disk.coveredFrom === 0 || disk.coveredFrom <= state.coveredFrom)
      )
        state = disk;
      if (isStale(state, { refresh, stale, now: start })) {
        const fresh = await fetchRevisions(
          {
            from:
              state.newest === null
                ? state.coveredFrom || undefined
                : state.newest - LOG_OVERLAP_MS,
          },
          signal,
        );
        const revisions = mergeRevisions(state.revisions, fresh);
        await save({
          ...state,
          newest: newestTime(revisions),
          fetchedAt: now(),
          revisions,
        });
        contacted = true;
        refreshed = true;
      }
    }
  } catch (error) {
    return { state, contacted, refreshed, error };
  }
  return { state, contacted, refreshed };
}
