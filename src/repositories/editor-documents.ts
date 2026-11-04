import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";

function within(root: string, target: string): boolean {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (!path.isAbsolute(relative) &&
      relative !== ".." &&
      !relative.startsWith(`..${path.sep}`))
  );
}

/** Resolve aliases even when an open editor's file has been deleted on disk. */
async function canonicalDocumentPath(file: string): Promise<string> {
  let current = path.resolve(file);
  const missing: string[] = [];
  for (;;) {
    try {
      return path.join(await fs.realpath(current), ...missing);
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (code !== "ENOENT" && code !== "ENOTDIR") throw error;
      const parent = path.dirname(current);
      if (parent === current) throw error;
      missing.unshift(path.basename(current));
      current = parent;
    }
  }
}

/** Repository roots are canonical, but editor URIs may use /var aliases or
 * symlinked workspace paths. Re-evaluate each time; never cache dirty state. */
export async function hasDirtyEditors(
  root: string,
  relativeFile?: string,
): Promise<boolean> {
  const documents = vscode.workspace.textDocuments.filter(
    (document) => document.isDirty && document.uri.scheme === "file",
  );
  if (!documents.length) return false;
  const canonicalRoot = await fs.realpath(root);
  const expected =
    relativeFile === undefined
      ? undefined
      : await canonicalDocumentPath(path.join(canonicalRoot, relativeFile));
  for (const document of documents) {
    const lexical = path.resolve(document.uri.fsPath);
    // Include the lexical target as well: overwriting a symlink would still
    // change the file associated with an editor opened through that path.
    if (
      expected === undefined
        ? within(canonicalRoot, lexical)
        : lexical === path.join(canonicalRoot, relativeFile as string)
    )
      return true;
    const actual = await canonicalDocumentPath(lexical);
    if (
      expected === undefined
        ? within(canonicalRoot, actual)
        : actual === expected
    )
      return true;
  }
  return false;
}

type EncodingWorkspace = typeof vscode.workspace & {
  decode?(
    content: Uint8Array,
    options: { uri: vscode.Uri } | { encoding: string },
  ): Thenable<string>;
  encode?(content: string, options: { uri: vscode.Uri }): Thenable<Uint8Array>;
};

/** 修订内容按右侧工作文件的编码解码（已打开文档优先，否则由 IDE 按设置与
 * 工程编码判定），再按 IDE 读取修订 URI 的编码写回，差异两侧编码一致。
 * 宿主没有编码 API 或内容为二进制时原样返回。 */
export async function revisionContent(
  revision: vscode.Uri,
  working: vscode.Uri,
  content: Uint8Array,
): Promise<Uint8Array> {
  const workspace = vscode.workspace as EncodingWorkspace;
  if (!workspace.decode || !workspace.encode || content.includes(0))
    return content;
  const document = workspace.textDocuments.find(
    (item) => item.uri.toString() === working.toString(),
  ) as { encoding?: string } | undefined;
  const text = await workspace.decode(
    content,
    document?.encoding ? { encoding: document.encoding } : { uri: working },
  );
  return workspace.encode(text, { uri: revision });
}
