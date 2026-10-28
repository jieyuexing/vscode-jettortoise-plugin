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
    const name = path.basename(file);
    if (/[\r\n\s*?[\]\\]/.test(name))
      throw new Error(
        vscode.l10n.t(
          "This file name cannot be represented safely in an ignore file.",
        ),
      );
    const ignore = path.posix.join(
      path.posix.dirname(file),
      kind === "git" ? ".gitignore" : ".cvsignore",
    );
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
    const before = await fs
      .readFile(target, "utf8")
      .catch((error: NodeJS.ErrnoException) => {
        if (error.code !== "ENOENT") throw error;
        return "";
      });
    const pattern = kind === "git" ? `/${name.replace(/[#!]/g, "\\$&")}` : name;
    if (!before.split(/\r?\n/).includes(pattern))
      await fs.writeFile(
        target,
        `${before}${before && !before.endsWith("\n") ? "\n" : ""}${pattern}\n`,
      );
  }
}
