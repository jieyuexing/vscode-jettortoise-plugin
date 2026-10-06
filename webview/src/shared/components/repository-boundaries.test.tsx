import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createVcsTranslator,
  VcsRepositoryBoundaries,
} from "../../../../packages/vcs-ui/src";

afterEach(cleanup);
describe("repository boundaries in the commit area", () => {
  it.each([
    "en",
    "zh-cn",
    "zh-tw",
    "de",
  ])("renders safe labels and opens a Host ID in %s", (language) => {
    const t = createVcsTranslator(language),
      onOpen = vi.fn();
    render(
      <VcsRepositoryBoundaries
        items={[
          {
            id: "trusted-token",
            kind: "git",
            path: "child/<img src=x onerror=alert(1)>",
            added: false,
          },
        ]}
        title={t("repository.nested")}
        openLabel={t("repository.open")}
        addLabel={t("repository.add")}
        onOpen={onOpen}
      />,
    );
    expect(document.querySelector("img")).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t("repository.add") }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith("trusted-token");
  });
  it("shows Open for registered children and no notice without children", () => {
    const props = {
      title: "Children",
      openLabel: "Open",
      addLabel: "Add",
      onOpen: vi.fn(),
    };
    const view = render(<VcsRepositoryBoundaries {...props} items={[]} />);
    expect(view.container.textContent).toBe("");
    view.rerender(
      <VcsRepositoryBoundaries
        {...props}
        items={[{ id: "child", kind: "cvs", path: "legacy", added: true }]}
      />,
    );
    expect(screen.getByRole("button", { name: "Open" })).toBeTruthy();
  });
});
