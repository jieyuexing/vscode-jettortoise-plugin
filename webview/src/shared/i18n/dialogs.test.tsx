import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CreateBranchDialog } from "../../panel/components/CreateBranchDialog";
import { PushDialog } from "../../panel/components/PushDialog";
import { initializeI18n } from "./index";

afterEach(cleanup);

describe("localized dialogs preserve actions and untrusted text", () => {
  it.each([
    "en",
    "zh-cn",
    "zh-tw",
    "de",
  ])("renders and confirms push in %s", (language) => {
    initializeI18n(language);
    const chinese = language.startsWith("zh");
    const onPush = vi.fn();
    const onClose = vi.fn();
    const branch = '<img src=x onerror="alert(1)">';
    const { container } = render(
      <PushDialog branchName={branch} onPush={onPush} onClose={onClose} />,
    );
    expect(container.textContent).toContain(branch);
    expect(container.querySelector("img")).toBeNull();
    fireEvent.click(
      screen.getByRole("button", {
        name: chinese ? "推送" : "Push",
        exact: true,
      }),
    );
    expect(onPush).toHaveBeenLastCalledWith(false);
    fireEvent.click(
      screen.getByRole("button", { name: chinese ? "强制推送" : "Force Push" }),
    );
    expect(onPush).toHaveBeenLastCalledWith(true);
    fireEvent.click(
      screen.getByRole("button", { name: chinese ? "取消" : "Cancel" }),
    );
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("localizes branch labels while preserving entered branch data", () => {
    initializeI18n("zh-cn");
    const onConfirm = vi.fn().mockResolvedValue(undefined);
    render(
      <CreateBranchDialog
        title="JetGit"
        onClose={vi.fn()}
        onConfirm={onConfirm}
      />,
    );
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "feature/example" },
    });
    fireEvent.click(screen.getByRole("button", { name: "创建" }));
    expect(onConfirm).toHaveBeenCalledWith({
      branchName: "feature/example",
      checkout: true,
      force: false,
    });
  });
});
