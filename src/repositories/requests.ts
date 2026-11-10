import { safeRelativePath } from "../git/security";

const fields: Record<string, readonly string[]> = {
  getRepositories: [],
  getFileIcons: ["filePaths"],
  getRepositoryChanges: [],
  refreshRepositories: [],
  scanRepository: [],
  removeSynchronizedRepository: [],
  collapseLocalChanges: [],
  selectRepository: ["surface"],
  commitRepositories: ["message", "files", "amend"],
  updateProject: [],
  expandUnversioned: ["filePath"],
  ignoreUnversioned: ["filePaths"],
  addUnversioned: ["filePaths"],
  getCvsFiles: [],
  getWorkingFilePreview: ["filePath", "staged"],
  getCvsHistory: ["filePath"],
  getCvsLog: ["days", "refresh"],
  getCvsCommit: ["commitId"],
  diffCvsRevision: ["filePath", "revision"],
};
/** 新入口只接受固定字段与登记 ID；普通 Git 命令继续使用原会话的合同。 */
export function validateRepositoryRequest(
  command: string,
  params: Record<string, unknown>,
) {
  if (
    params.repositoryId !== undefined &&
    (typeof params.repositoryId !== "string" ||
      !/^[a-f0-9]{32}$/.test(params.repositoryId))
  )
    throw new Error("Invalid repository ID.");
  if (!Object.hasOwn(fields, command)) return;
  if (command === "scanRepository" && params.repositoryId === undefined)
    throw new Error("Invalid repository ID.");
  for (const key of Object.keys(params))
    if (key !== "repositoryId" && !fields[command].includes(key))
      throw new Error(`Unexpected request field: ${key}`);
  const required = fields[command];
  for (const key of required)
    if (
      params[key] === undefined &&
      !["amend", "staged", "refresh"].includes(key)
    )
      throw new Error(`Missing request field: ${key}`);
  if (
    command === "getWorkingFilePreview" &&
    params.staged !== undefined &&
    typeof params.staged !== "boolean"
  )
    throw new Error("Invalid staged flag.");
  if (Object.hasOwn(params, "filePath"))
    safeRelativePath(params.filePath as string);
  if (Object.hasOwn(params, "filePaths")) {
    if (!Array.isArray(params.filePaths) || !params.filePaths.length)
      throw new Error("Select files.");
    for (const file of params.filePaths) safeRelativePath(file);
  }
  if (
    command === "selectRepository" &&
    !["commit", "log"].includes(params.surface as string)
  )
    throw new Error("Invalid selection surface.");
  if (
    command === "getCvsLog" &&
    (!Number.isInteger(params.days) ||
      (params.days as number) < 0 ||
      (params.days as number) > 36500 ||
      (params.refresh !== undefined && typeof params.refresh !== "boolean"))
  )
    throw new Error("Invalid log range.");
  if (
    command === "getCvsCommit" &&
    (typeof params.commitId !== "string" ||
      !params.commitId ||
      params.commitId.length > 4096 ||
      params.commitId.includes("\0"))
  )
    throw new Error("Invalid commit.");
  if (
    command === "diffCvsRevision" &&
    (typeof params.revision !== "string" ||
      !/^[1-9]\d*(?:\.\d+)+$/.test(params.revision))
  )
    throw new Error("Invalid CVS revision.");
  if (command === "commitRepositories") {
    if (params.amend !== undefined && typeof params.amend !== "boolean")
      throw new Error("Invalid amend flag.");
    // 空说明只在合并类操作进行中由 Git 会话接受，此处只校验形状。
    if (
      typeof params.message !== "string" ||
      params.message.length > 16000 ||
      params.message.includes("\0")
    )
      throw new Error("Enter a commit message.");
    // 文件为空只用于合并进行中直接提交，须指明仓库。
    if (
      !Array.isArray(params.files) ||
      (!params.files.length && params.repositoryId === undefined)
    )
      throw new Error("Select changed files.");
    for (const file of params.files) {
      if (
        !file ||
        typeof file !== "object" ||
        Object.keys(file).some(
          (key) => !["repositoryId", "path"].includes(key),
        ) ||
        !/^[a-f0-9]{32}$/.test(file.repositoryId)
      )
        throw new Error("Invalid selected file.");
      safeRelativePath(file.path);
    }
  }
}

export function repositoryPath(value: unknown): string {
  return safeRelativePath(value as string).replace(/\\/g, "/");
}
