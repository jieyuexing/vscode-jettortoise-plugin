import * as fs from "node:fs/promises";
import * as path from "node:path";
import { within } from "tortoise-core/boundaries";
import * as vscode from "vscode";

interface Associations {
  file?: string;
  fileNames?: Record<string, string>;
  fileExtensions?: Record<string, string>;
}
interface IconTheme extends Associations {
  iconDefinitions: Record<string, { iconPath?: string }>;
  light?: Associations;
}
export interface FileIcon {
  light: string;
  dark: string;
}
let cached: { id: string; theme: Promise<LoadedTheme | undefined> } | undefined;
interface LoadedTheme {
  root: string;
  directory: string;
  data: IconTheme;
  images: Map<string, Promise<string | undefined>>;
}
export function clearFileIconCache() {
  cached = undefined;
}
async function installedTheme(): Promise<LoadedTheme | undefined> {
  const id = vscode.workspace
    .getConfiguration("workbench")
    .get<string>("iconTheme", "");
  if (cached?.id === id) return cached.theme;
  const theme = (async () => {
    for (const extension of vscode.extensions?.all ?? []) {
      const contribution = (
        extension.packageJSON.contributes?.iconThemes as
          | { id: string; path: string }[]
          | undefined
      )?.find((item) => item.id === id);
      if (!contribution) continue;
      const root = await fs.realpath(extension.extensionUri.fsPath);
      const file = await fs.realpath(path.resolve(root, contribution.path));
      if (!within(root, file) || (await fs.stat(file)).size > 4 * 1024 * 1024)
        return;
      const data = JSON.parse(await fs.readFile(file, "utf8")) as IconTheme;
      return {
        root,
        directory: path.dirname(file),
        data,
        images: new Map<string, Promise<string | undefined>>(),
      };
    }
  })().catch(() => undefined);
  cached = { id, theme };
  return theme;
}
function iconId(
  theme: IconTheme,
  file: string,
  light: boolean,
): string | undefined {
  const variant = light ? theme.light : undefined;
  const name = path.posix.basename(file).toLowerCase();
  const named = variant?.fileNames?.[name] ?? theme.fileNames?.[name];
  if (named) return named;
  const parts = name.split(".");
  for (let i = 1; i < parts.length; i++) {
    const extension = parts.slice(i).join(".");
    const found =
      variant?.fileExtensions?.[extension] ?? theme.fileExtensions?.[extension];
    if (found) return found;
  }
  return variant?.file ?? theme.file;
}
function image(
  theme: LoadedTheme,
  id: string | undefined,
): Promise<string | undefined> {
  if (!id) return Promise.resolve(undefined);
  const previous = theme.images.get(id);
  if (previous) return previous;
  const result = (async () => {
    const relative = theme.data.iconDefinitions[id]?.iconPath;
    if (!relative) return;
    const file = await fs.realpath(path.resolve(theme.directory, relative));
    if (!within(theme.root, file)) return;
    const mime: Record<string, string> = {
      ".svg": "image/svg+xml",
      ".png": "image/png",
      ".webp": "image/webp",
    };
    const type = mime[path.extname(file).toLowerCase()];
    if (!type || (await fs.stat(file)).size > 128 * 1024) return;
    const bytes = await fs.readFile(file);
    if (bytes.length > 128 * 1024) return;
    return `data:${type};base64,${bytes.toString("base64")}`;
  })().catch(() => undefined);
  theme.images.set(id, result);
  return result;
}
/** 只读当前已安装图标主题，不激活插件、不读工作副本、不请求网络。 */
export async function getFileIcons(
  files: string[],
): Promise<Record<string, FileIcon | null>> {
  const theme = await installedTheme();
  const result: Record<string, FileIcon | null> = {};
  for (const file of files) {
    const [light, dark] = theme
      ? await Promise.all([
          image(theme, iconId(theme.data, file, true)),
          image(theme, iconId(theme.data, file, false)),
        ])
      : [];
    result[file] = light && dark ? { light, dark } : null;
  }
  return result;
}
