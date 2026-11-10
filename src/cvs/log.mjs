// 仓库级 cvs log：解析多文件输出，并把文件修订合成“提交”。纯函数，不执行命令、不读文件。

/** 没有 commitid 时，同作者同说明、相邻修订相差不超过这个秒数就归为同一个提交（与 cvsps 同思路）。 */
export const COMMIT_WINDOW_SECONDS = 60;

const utf8 = new TextDecoder("utf-8", { fatal: true });
let shiftJis;
try {
  shiftJis = new TextDecoder("shift_jis");
} catch {
  // 宿主的 Node 没有完整 ICU 时无法解码 MS932，按 UTF-8 宽松解码。
}

// 日志按字节读入（latin1 一字节一字符）；每个字段单独解码：严格 UTF-8，不合法再按 MS932。
function decodeBytes(text) {
  if (!/[\x80-\xff]/.test(text)) return text;
  const bytes = Buffer.from(text, "latin1");
  try {
    return utf8.decode(bytes);
  } catch {
    return shiftJis ? shiftJis.decode(bytes) : bytes.toString("utf8");
  }
}

/** `2026-11-10 12:08:39 +0800`（CVS 1.12）与 `2026/10/28 08:02:03`（旧版本，UTC）。 */
export function parseLogDate(text) {
  const match = text
    .trim()
    .match(
      /^(\d{4})[-/](\d\d)[-/](\d\d) (\d\d):(\d\d):(\d\d)(?: ([+-])(\d\d):?(\d\d))?$/,
    );
  if (!match) return Number.NaN;
  const [
    ,
    year,
    month,
    day,
    hour,
    minute,
    second,
    sign,
    offsetHour,
    offsetMinute,
  ] = match;
  const offset = sign
    ? (sign === "-" ? -1 : 1) * (Number(offsetHour) * 60 + Number(offsetMinute))
    : 0;
  return Date.UTC(year, month - 1, day, hour, minute, second) - offset * 60000;
}

/**
 * `cvs rlog` 输出里的 RCS 文件换算成相对工作副本根的路径：去掉服务器上的 Root 路径与模块前缀、
 * 已删除文件所在的 Attic/ 和末尾的 ,v。路径不在该模块下时返回 undefined。
 * Root 路径与服务器真实路径不一致时（例如 CVSNT 的虚拟路径），退而按模块前缀 /<repository>/ 截取。
 */
export function rlogPath(rcsFile, rootPath, repository) {
  const file = rcsFile.trim().replace(/,v$/, "");
  const prefix = `${rootPath}/${repository}/`;
  let relative;
  if (rootPath && file.startsWith(prefix)) relative = file.slice(prefix.length);
  else {
    const marker = `/${repository}/`;
    const index = file.indexOf(marker);
    if (index < 0) return undefined;
    relative = file.slice(index + marker.length);
  }
  return relative.replace(/(^|\/)Attic\/(?=[^/]+$)/, "$1");
}

/**
 * 解析 `cvs rlog` 的多文件输出（Buffer 或已解码的字符串），返回文件修订：
 * `{ path, revision, time(ms), author, state, commitId, message }`。
 * toPath 把 RCS file 行换算成相对工作副本根的路径（见 rlogPath），返回 undefined 的文件被忽略。
 * 没有选中修订的文件块（未加 -S）不产生记录。
 */
export function parseRepositoryLog(input, toPath) {
  const decoded = typeof input === "string";
  const text = decoded ? input : input.toString("latin1");
  const decode = decoded ? (value) => value : decodeBytes;
  const starts = [...text.matchAll(/^RCS file: /gm)].map(
    (match) => match.index,
  );
  const revisions = [];
  starts.forEach((start, index) => {
    const block = text.slice(start, starts[index + 1] ?? text.length);
    const rcs = block.match(/^RCS file: ([^\r\n]*)/)?.[1];
    const path = rcs === undefined ? undefined : toPath(decode(rcs));
    if (path === undefined) return;
    // 第一段是文件头；其后每段以 revision 行开头。
    for (const chunk of block.split(/^-{28}\r?\n(?=revision \S+)/m).slice(1)) {
      const match = chunk.match(
        /^revision (\S+)[^\r\n]*\r?\ndate: ([^;]+);\s*author: ([^;]+);\s*state: ([^;]+);([^\r\n]*)(?:\r?\n([\s\S]*))?$/,
      );
      if (!match) continue;
      const time = parseLogDate(match[2]);
      if (Number.isNaN(time)) continue;
      const message = (match[6] ?? "")
        .replace(/(?:^|\r?\n)={77}\s*$/, "")
        .replace(/^branches:[^\r\n]*\r?\n?/, "")
        .trim();
      revisions.push({
        path,
        revision: match[1],
        time,
        author: decode(match[3].trim()),
        state: match[4].trim(),
        commitId: match[5].match(/commitid: ([^;\s]+)/)?.[1],
        message: decode(message),
      });
    }
  });
  return revisions;
}

/** 修订的上一个修订：主干减一；分支首个修订回到分支点；1.1 没有上一个。 */
export function previousRevision(revision) {
  const parts = revision.split(".").map(Number);
  if (parts.at(-1) > 1)
    return [...parts.slice(0, -1), parts.at(-1) - 1].join(".");
  return parts.length > 2 ? parts.slice(0, -2).join(".") : undefined;
}

export function compareRevisions(a, b) {
  const left = a.split(".").map(Number),
    right = b.split(".").map(Number);
  for (let index = 0; index < Math.min(left.length, right.length); index++)
    if (left[index] !== right[index]) return left[index] - right[index];
  return left.length - right.length;
}
const compareText = (a, b) => a.localeCompare(b);

function fileChange(item) {
  const previous = previousRevision(item.revision);
  return {
    path: item.path,
    revision: item.revision,
    previous,
    kind:
      item.state === "dead"
        ? "deleted"
        : previous === undefined
          ? "added"
          : "modified",
  };
}

// 导入同时产生主干 1.1 与厂商分支 1.1.1.1（同作者同时刻）：折成一个主干修订，说明取导入时写的那条，
// commitid 沿用（没有 commitid 的服务器上两者说明不同，否则会被拆成两个提交）。
function foldImports(revisions) {
  const trunk = new Map(
    revisions
      .filter((item) => item.revision === "1.1")
      .map((item) => [item.path, item]),
  );
  const imported = new Map();
  const rest = revisions.filter((item) => {
    const twin = item.revision === "1.1.1.1" && trunk.get(item.path);
    if (!twin || twin.author !== item.author || twin.time !== item.time)
      return true;
    imported.set(twin, item);
    return false;
  });
  return rest.map((item) => {
    const vendor = imported.get(item);
    return vendor
      ? {
          ...item,
          message: vendor.message,
          commitId: item.commitId ?? vendor.commitId,
        }
      : item;
  });
}

/**
 * 把文件修订合成提交，按时间倒序。
 * - 有 commitid：同 commitid 一个提交；
 * - 没有：按时间升序，同作者同说明、与组内最近一个修订相差不超过 windowSeconds、且该文件尚未在组内，就并入，否则另起一组；
 * - 同一提交里一个文件只出一行：导入产生的 1.1 与厂商分支 1.1.1.1 折成主干修订（见 foldImports）；
 * - 分支上新增文件时主干留下的 dead 1.1 只是占位，不算删除。
 */
export function groupCommits(revisions, windowSeconds = COMMIT_WINDOW_SECONDS) {
  const windowMs = windowSeconds * 1000;
  // 重复的 path@revision 不能让“同一文件第二次出现”把一个提交拆开。
  const ordered = foldImports(
    uniqueRevisions(revisions).filter(
      (item) => !(item.state === "dead" && item.revision === "1.1"),
    ),
  ).sort(
    (a, b) =>
      a.time - b.time ||
      compareText(a.path, b.path) ||
      compareRevisions(a.revision, b.revision),
  );
  const byCommitId = new Map(),
    open = new Map(),
    groups = [];
  for (const item of ordered) {
    const key = `${item.author}\0${item.message}`;
    let group = item.commitId ? byCommitId.get(item.commitId) : open.get(key);
    if (
      group &&
      !item.commitId &&
      (item.time - group.last > windowMs || group.files.has(item.path))
    )
      group = undefined;
    if (!group) {
      group = {
        id: item.commitId,
        first: item,
        last: item.time,
        author: item.author,
        message: item.message,
        files: new Map(),
      };
      groups.push(group);
      if (item.commitId) byCommitId.set(item.commitId, group);
      else open.set(key, group);
    }
    group.last = Math.max(group.last, item.time);
    if (!group.files.has(item.path)) group.files.set(item.path, item);
  }
  return groups
    .map((group) => ({
      id:
        group.id ??
        `${group.first.time}:${group.first.author}:${group.first.path}`,
      time: group.last,
      author: group.author,
      message: group.message,
      files: [...group.files.values()]
        .sort((a, b) => compareText(a.path, b.path))
        .map(fileChange),
    }))
    .sort((a, b) => b.time - a.time || compareText(a.id, b.id));
}

/** 毫秒时间戳的统一显示：`2026-11-10 04:08:39 +0000`。 */
export function logDate(time) {
  const iso = new Date(time).toISOString();
  return `${iso.slice(0, 10)} ${iso.slice(11, 19)} +0000`;
}

/** `cvs log -d` 的日期范围（含两端，UTC）；两端都缺省则不加 -d。 */
export function logRangeArgs({ from, to } = {}) {
  if (from !== undefined && to !== undefined)
    return ["-d", `${logDate(from)}<=${logDate(to)}`];
  if (from !== undefined) return ["-d", `>=${logDate(from)}`];
  if (to !== undefined) return ["-d", `<=${logDate(to)}`];
  return [];
}

/** 每个 path@revision 只留第一条：服务器可能重复输出同一个文件修订，相邻范围的两端也会重叠。 */
export function uniqueRevisions(revisions) {
  const seen = new Set(),
    unique = [];
  for (const item of revisions) {
    const key = `${item.path}\0${item.revision}`;
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(item);
  }
  return unique;
}

/** 合并两次取到的修订；相邻范围含两端，同一文件修订只留一条。 */
export function mergeRevisions(existing, incoming) {
  return uniqueRevisions([...existing, ...incoming]);
}
