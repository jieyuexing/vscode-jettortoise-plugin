import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import {
  VcsDiffPreview,
  VcsRepositoryList,
} from "../../../../packages/vcs-ui/src";

const repositoryLabels = {
  search: "Search repositories",
  add: "Add",
  scan: "Scan",
  restore: "Restore",
  open: "Open workbench",
  openCommit: "Open commit",
  update: "Update files",
  refresh: "Refresh",
  copyPath: "Copy path",
  remove: "Remove",
  unavailable: "Unavailable",
  empty: "No repositories",
};

describe("workbench presentational components", () => {
  it("filters catalog entries and sends only their opaque ids to callbacks", () => {
    const open = vi.fn();
    render(
      <VcsRepositoryList
        labels={repositoryLabels}
        onOpen={open}
        items={[
          { id: "catalog-git-a", name: "platform", kind: "git", ref: "main" },
          { id: "catalog-cvs-b", name: "legacy", kind: "cvs", ref: "1.42" },
        ]}
      />,
    );
    fireEvent.change(
      screen.getByRole("searchbox", { name: "Search repositories" }),
      { target: { value: "legacy" } },
    );
    expect(screen.queryByText("platform")).toBeNull();
    fireEvent.click(screen.getByText("legacy"));
    expect(open).toHaveBeenCalledWith("catalog-cvs-b");
  });

  it("renders diff text as text and allows mode and native actions", () => {
    const mode = vi.fn();
    const native = vi.fn();
    render(
      <VcsDiffPreview
        labels={{
          split: "Split",
          inline: "Inline",
          previousChange: "Previous",
          nextChange: "Next",
          openNative: "Open native",
          openFile: "Open file",
          noPreview: "No preview",
        }}
        onModeChange={mode}
        onOpenNative={native}
        comparison={{
          id: "safe-preview",
          source: "Working tree",
          left: { label: "index", text: "const a = 1;" },
          right: { label: "worktree", text: "<img src=x>" },
        }}
      />,
    );
    expect(screen.getByText("<img src=x>")).toBeTruthy();
    expect(document.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Inline" }));
    expect(mode).toHaveBeenCalledWith("inline");
    fireEvent.click(screen.getByRole("button", { name: "Open native" }));
    expect(native).toHaveBeenCalledTimes(1);
  });

  it("windows a large preview instead of mounting every diff line", () => {
    const text = Array.from(
      { length: 20_000 },
      (_, index) => `line-${index}`,
    ).join("\n");
    const { container } = render(
      <VcsDiffPreview
        labels={{
          split: "Split",
          inline: "Inline",
          previousChange: "Previous",
          nextChange: "Next",
          openNative: "Open native",
          openFile: "Open file",
          noPreview: "No preview",
        }}
        comparison={{
          id: "large",
          source: "Working tree",
          left: { label: "left", text },
          right: { label: "right", text: `${text}\nchanged` },
        }}
      />,
    );
    expect(container.querySelectorAll(".vcs-ui-diff-line").length).toBeLessThan(
      200,
    );
  });
});
