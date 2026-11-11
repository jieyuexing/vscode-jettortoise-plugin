// 落盘缓存：仓库日志的修订、单文件历史与修订内容。只存在扩展存储目录里；键只含主机与路径，
// 不含用户、口令或端口；格式带版本号，读不懂或损坏的文件直接丢弃重取。
import { createHash } from "node:crypto";
import * as fs from "node:fs/promises";
import path from "node:path";

export const CACHE_VERSION = 1;
/** 距上次连服务器不到这么久，打开日志不再连服务器。 */
export const LOG_FRESH_MS = 5 * 60 * 1000;
/** 增量取数从最新缓存时间往回退这么久，吸收时钟差与同一时刻的提交；按 path@revision 去重。 */
export const LOG_OVERLAP_MS = 5 * 60 * 1000;
/** 修订内容缓存的总量上限，超出时按最近使用淘汰。 */
export const CONTENT_LIMIT_BYTES = 200 * 1024 * 1024;
const MAX_HISTORY_FILES = 2000;

/** CVSROOT 里的路径部分（服务器上的仓库根），用于把 RCS file 换算成相对路径。 */
export function rootPath(root) {
  const match = root.match(/^:(\w+):(.*)$/);
  if (!match) return root;
  if (match[1] === "pserver")
    return match[2].match(/^(?:[^@/]*@)?[^:/]+(?::\d*:?)?(\/.*)$/)?.[1] ?? "";
  return match[2];
}

/** 缓存键里的仓库标识：去掉用户、口令与端口，只留主机与路径。 */
export function rootIdentity(root) {
  const match = root.match(/^:(\w+):(.*)$/);
  if (!match) return `local:${root}`;
  if (match[1] === "pserver") {
    const parts = match[2].match(/^(?:[^@/]*@)?([^:/]+)(?::\d*:?)?(\/.*)$/);
    if (parts) return `${parts[1].toLowerCase()}${parts[2]}`;
  }
  return `${match[1]}:${match[2].replace(/^[^@/]*@/, "")}`;
}

const hash = (...parts) =>
  createHash("sha256").update(parts.join("\0")).digest("hex");

async function readJson(file, valid) {
  let data;
  try {
    data = JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error.code === "ENOENT") return undefined;
  }
  if (data?.version === CACHE_VERSION && valid(data)) return data;
  await fs.rm(file, { force: true });
  return undefined;
}

async function writeFileAtomic(file, data) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  await fs.writeFile(temp, data, { mode: 0o600 });
  await fs.rename(temp, file);
}

const validRevision = (item) =>
  item &&
  typeof item.path === "string" &&
  typeof item.revision === "string" &&
  Number.isFinite(item.time) &&
  typeof item.author === "string" &&
  typeof item.state === "string" &&
  typeof item.message === "string";

const validLog = (data) =>
  Number.isFinite(data.coveredFrom) &&
  data.coveredFrom >= 0 &&
  Number.isFinite(data.fetchedAt) &&
  (data.newest === null || Number.isFinite(data.newest)) &&
  Array.isArray(data.revisions) &&
  data.revisions.every(validRevision);

const validHistories = (data) =>
  data.files &&
  typeof data.files === "object" &&
  Object.values(data.files).every(
    (entry) =>
      typeof entry?.entryRevision === "string" &&
      Number.isFinite(entry.fetchedAt) &&
      Array.isArray(entry.revisions),
  );

export class CvsCacheStore {
  constructor(directory, { contentLimit = CONTENT_LIMIT_BYTES } = {}) {
    this.directory = directory;
    this.contentLimit = contentLimit;
    this.contentBytes = undefined;
  }
  /** 清除全部缓存（日志、单文件历史、修订内容）。 */
  async clear() {
    this.contentBytes = undefined;
    await fs.rm(this.directory, { recursive: true, force: true });
  }
  /** identity：{ root（CVSROOT）, repository（CVS/Repository）, branch, workingCopy（工作副本根路径） }。 */
  repository(identity) {
    return new RepositoryCache(this, identity);
  }
  get contentDirectory() {
    return path.join(this.directory, "content");
  }
  async #entries() {
    const entries = [];
    for (const name of await fs.readdir(this.contentDirectory).catch(() => []))
      if (!name.endsWith(".tmp")) {
        const stat = await fs
          .stat(path.join(this.contentDirectory, name))
          .catch(() => undefined);
        if (stat?.isFile())
          entries.push({ name, size: stat.size, used: stat.mtimeMs });
      }
    return entries;
  }
  async storeContent(key, bytes) {
    if (bytes.length > this.contentLimit / 4) return;
    const file = path.join(this.contentDirectory, key);
    if (this.contentBytes === undefined)
      this.contentBytes = (await this.#entries()).reduce(
        (total, entry) => total + entry.size,
        0,
      );
    const existing = await fs.stat(file).catch(() => undefined);
    if (existing) {
      await this.touch(file);
      return;
    }
    await writeFileAtomic(file, bytes);
    this.contentBytes += bytes.length;
    if (this.contentBytes <= this.contentLimit) return;
    // 按最近使用淘汰到上限的 90%；刚写入的最后淘汰。
    const entries = (await this.#entries()).sort((a, b) => a.used - b.used);
    let total = entries.reduce((sum, entry) => sum + entry.size, 0);
    for (const entry of entries) {
      if (total <= this.contentLimit * 0.9) break;
      await fs.rm(path.join(this.contentDirectory, entry.name), {
        force: true,
      });
      total -= entry.size;
    }
    this.contentBytes = total;
  }
  async touch(file) {
    const now = new Date();
    await fs.utimes(file, now, now).catch(() => {});
  }
}

class RepositoryCache {
  constructor(store, identity) {
    this.store = store;
    this.identity = identity;
    const { root, repository, branch, workingCopy } = identity;
    this.base = rootIdentity(root);
    this.key = hash(this.base, repository, branch, hash(workingCopy));
    this.logFile = path.join(store.directory, `log-${this.key}.json`);
    this.historyFile = path.join(store.directory, `history-${this.key}.json`);
  }
  readLog() {
    return readJson(this.logFile, validLog);
  }
  async writeLog(state) {
    await writeFileAtomic(
      this.logFile,
      JSON.stringify({ version: CACHE_VERSION, ...state }),
    );
  }
  async readHistories() {
    return (await readJson(this.historyFile, validHistories))?.files ?? {};
  }
  async writeHistories(files) {
    const kept = Object.entries(files)
      .sort((a, b) => b[1].fetchedAt - a[1].fetchedAt)
      .slice(0, MAX_HISTORY_FILES);
    await writeFileAtomic(
      this.historyFile,
      JSON.stringify({
        version: CACHE_VERSION,
        files: Object.fromEntries(kept),
      }),
    );
  }
  // 修订不可变：键只与主机、路径、模块内路径和修订有关，与工作副本无关。
  contentKey(file, revision) {
    return hash(this.base, `${this.identity.repository}/${file}`, revision);
  }
  async readContent(file, revision) {
    const target = path.join(
      this.store.contentDirectory,
      this.contentKey(file, revision),
    );
    try {
      const bytes = await fs.readFile(target);
      await this.store.touch(target);
      return bytes;
    } catch {
      return undefined;
    }
  }
  writeContent(file, revision, bytes) {
    return this.store.storeContent(this.contentKey(file, revision), bytes);
  }
}
