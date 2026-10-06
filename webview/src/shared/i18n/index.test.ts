import { describe, expect, it } from "vitest";
import {
  initializeI18n,
  normalizeLanguage,
  t,
  translateUnknown,
} from "./index";

describe("webview i18n", () => {
  it("normalizes the supported Chinese display languages", () => {
    expect(normalizeLanguage("zh")).toBe("zh-cn");
    expect(normalizeLanguage("zh-CN")).toBe("zh-cn");
    expect(normalizeLanguage("zh-tw")).toBe("zh-cn");
    expect(normalizeLanguage("ja")).toBe("en");
  });

  it("uses Chinese where available and English for all other languages", () => {
    initializeI18n("zh-cn");
    expect(t("push.push")).toBe("推送");
    initializeI18n("fr");
    expect(t("push.push")).toBe("Push");
  });

  it("interpolates parameters", () => {
    initializeI18n("zh");
    expect(t("push.pushed", { count: 2, target: "origin/main" })).toBe(
      "已推送 2 个提交到 origin/main",
    );
    expect(t("panel.createBranch", { startPoint: "abc123" })).toBe(
      "从 abc123 创建分支",
    );
  });

  it("does not expose an unknown translation key", () => {
    expect(t("missing.key" as never)).toBe("Text unavailable");
    expect(translateUnknown("missing.key")).toBe("Text unavailable");
  });
});
