import { fireEvent, render, screen } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../shared/i18n";

const unshelveChanges = vi.fn();
const deleteShelve = vi.fn();

vi.mock("../../shared/store/commit-store", () => ({
  useCommitStore: () => ({ unshelveChanges, deleteShelve }),
}));

import { ShelfContextMenu } from "./ShelfContextMenu";

describe("ShelfContextMenu localization", () => {
  beforeEach(() => {
    initializeI18n("zh-cn");
    unshelveChanges.mockClear();
    deleteShelve.mockClear();
  });

  it("renders translated menu actions and preserves the shelve action payload", () => {
    render(
      <ShelfContextMenu
        x={0}
        y={0}
        entry={{
          id: "stash@{0}",
          message: "work",
          date: "2026-09-12",
          branch: "main",
          files: [],
        }}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByText("取消搁置..."));
    expect(unshelveChanges).toHaveBeenCalledWith("stash@{0}", true);
    expect(screen.getByText("恢复")).toBeTruthy();
    expect(screen.getByText("删除...")).toBeTruthy();
  });
});
