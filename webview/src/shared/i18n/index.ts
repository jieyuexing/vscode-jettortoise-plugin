import { en, zhCn } from "./locales";

export type TranslationKey = keyof typeof en;
export type TranslationParams = Record<string, string | number>;
type Locale = "en" | "zh-cn";

let locale: Locale = "en";

export function normalizeLanguage(language?: string): Locale {
  const normalized = language?.trim().toLowerCase().replace(/_/g, "-");
  return normalized === "zh" || normalized === "zh-cn" || normalized === "zh-tw"
    ? "zh-cn"
    : "en";
}

export function initializeI18n(language?: string): void {
  locale = normalizeLanguage(language);
}

export function t(key: TranslationKey, params: TranslationParams = {}): string {
  if (!Object.hasOwn(en, key)) return "Text unavailable";
  const template = (locale === "zh-cn" ? zhCn[key] : undefined) ?? en[key];
  return template.replace(/\{(\w+)\}/g, (match, name: string) =>
    Object.hasOwn(params, name) ? String(params[name]) : match,
  );
}

/** A safe display value for dynamically selected keys. */
export function translateUnknown(
  key: string,
  params: TranslationParams = {},
): string {
  return t(key as TranslationKey, params);
}
