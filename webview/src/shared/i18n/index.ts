import { en, zhCn } from "./locales";

type TranslationKey = keyof typeof en;
let chinese =
  typeof document !== "undefined" &&
  document.getElementById("root")?.dataset.language?.toLowerCase() === "zh-cn";

export function initializeI18n(language?: string): void {
  chinese = language?.toLowerCase().replace(/_/g, "-") === "zh-cn";
}

export function t(
  key: TranslationKey,
  ...values: (string | number | undefined)[]
): string {
  const template = (chinese ? zhCn[key] : undefined) || en[key];
  return template.replace(/\{(\d+)\}/g, (match, index: string) =>
    Number(index) < values.length ? String(values[Number(index)]) : match,
  );
}

export function fileCount(count: number): string {
  return count === 1 ? t("{0} file", count) : t("{0} files", count);
}
