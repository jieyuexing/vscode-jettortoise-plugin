import { describe, expect, it } from "vitest";
import {
  createVcsTranslator,
  normalizeVcsUiLanguage,
} from "../../../../packages/vcs-ui/src/i18n";

describe("shared VCS UI", () => {
  it("uses the supported Chinese aliases and falls back to English", () => {
    expect(normalizeVcsUiLanguage("zh")).toBe("zh-cn");
    expect(normalizeVcsUiLanguage("zh-tw")).toBe("zh-cn");
    expect(normalizeVcsUiLanguage("de")).toBe("en");
    expect(createVcsTranslator("zh-tw")("history.revisions")).toBe("修订记录");
    expect(createVcsTranslator("de")("history.revisions")).toBe("Revisions");
    expect(createVcsTranslator("en")("missing.key" as never)).toBe(
      "Unknown label",
    );
    expect(createVcsTranslator("zh-cn")("missing.key" as never)).toBe(
      "未知标签",
    );
  });
});
