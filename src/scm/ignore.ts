import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as vscode from "vscode";
import { resolveWorktreePath, safeRelativePath } from "../git/security";
import { assertOwnedPath } from "../repositories/boundaries.cjs";
import type { RepositoryKind } from "../repositories/types";

/** 每项写入前后都检查归属；拒绝符号链接和任意模式注入。 */
export async function ignorePaths(
  root: string,
  kind: RepositoryKind,
  paths: string[],
  guard: () => Promise<void>,
): Promise<void> {
  for (const value of paths) {
    const file = safeRelativePath(value);
    await guard();
    await assertOwnedPath(root, kind, file);
    const { name, directory } =
      kind === "git"
        ? {
            name: path.posix.basename(file),
            directory: path.posix.dirname(file),
          }
        : await cvsIgnoreTarget(root, file);
    if (/[\r\n\s*?[\]\\]/.test(name))
      throw new Error(
        vscode.l10n.t(
          "This file name cannot be represented safely in an ignore file.",
        ),
      );
    const ignore = path.posix.join(
      directory,
      kind === "git" ? ".gitignore" : ".cvsignore",
    );
    const pattern = kind === "git" ? `/${name.replace(/[#!]/g, "\\$&")}` : name;
    const existing = await resolveWorktreePath(root, ignore, {
      allowMissing: true,
    });
    if ((await readIgnore(existing)).split(/\r?\n/).includes(pattern)) continue;
    const label = vscode.l10n.t("Ignore");
    if (
      (await vscode.window.showWarningMessage(
        vscode.l10n.t("Add {0} to {1}?", name, ignore),
        { modal: true },
        label,
      )) !== label
    )
      return;
    await guard();
    await assertOwnedPath(root, kind, file);
    await assertOwnedPath(root, kind, ignore);
    const target = await resolveWorktreePath(root, ignore, {
      allowMissing: true,
    });
    const before = await readIgnore(target);
    if (!before.split(/\r?\n/).includes(pattern))
      await fs.writeFile(
        target,
        `${before}${before && !before.endsWith("\n") ? "\n" : ""}${pattern}\n`,
      );
  }
}

function readIgnore(file: string): Promise<string> {
  return fs.readFile(file, "utf8").catch((error: NodeJS.ErrnoException) => {
    if (error.code !== "ENOENT") throw error;
    return "";
  });
}
/** CVS 不进入未管理目录，所以忽略最上层未管理目录，写在其已管理的父目录。 */
async function cvsIgnoreTarget(root: string, file: string) {
  const parts = file.split("/");
  for (let index = 0; index < parts.length - 1; index++) {
    const admin = await fs
      .lstat(path.join(root, ...parts.slice(0, index + 1), "CVS"))
      .catch(() => undefined);
    if (!admin?.isDirectory())
      return {
        name: parts[index],
        directory: parts.slice(0, index).join("/") || ".",
      };
  }
  return { name: parts[parts.length - 1], directory: path.posix.dirname(file) };
}
