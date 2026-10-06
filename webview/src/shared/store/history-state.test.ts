import { describe, expect, it } from "vitest";
import { readHistoryState } from "./history-state";

describe("history view persistence", () => {
  it("restores filters and revision selection without storing repository content", () => {
    const hash = "a".repeat(40);
    const result = readHistoryState({
      version: 1,
      filter: {
        file: "folder/文件.ts",
        searchQuery: "</script>",
        branch: "topic",
      },
      selectedCommitHashes: [hash],
      visibleColumns: { hash: false },
      content: "never persist this",
    });
    expect(result.filter.file).toBe("folder/文件.ts");
    expect(result.filter.searchQuery).toBe("</script>");
    expect(result.selectedCommitHashes).toEqual([hash]);
    expect(result.visibleColumns.hash).toBe(false);
    expect(result).not.toHaveProperty("content");
  });

  it("falls back on invalid or old state and drops invalid selections", () => {
    for (const value of [null, 42, "state", { version: 2 }]) {
      expect(readHistoryState(value).filter.file).toBe("");
    }
    expect(
      readHistoryState({
        version: 1,
        filter: { file: 3 },
        selectedCommitHashes: ["../file", null],
      }).selectedCommitHashes,
    ).toEqual([]);
  });
});
