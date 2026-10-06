import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initializeI18n } from "../../shared/i18n";
import { CommitContextMenu } from "./CommitContextMenu";

const mock = vi.hoisted(() => ({ request: vi.fn(async () => ({})) }));
vi.mock("../../shared/bridge", () => ({
  bridge: { request: mock.request },
  bridgeWithProgress: mock.request,
}));
vi.mock("../../shared/store/panel-store", () => ({
  usePanelStore: (selector: (state: unknown) => unknown) =>
    selector({
      currentBranch: "main",
      filter: { file: "" },
      selectCommit: vi.fn(),
    }),
}));
afterEach(() => {
  cleanup();
  mock.request.mockClear();
});

const hash = "a".repeat(40);
const commit = {
  hash,
  shortHash: hash.slice(0, 8),
  subject: "Untrusted <script>text</script>",
  body: "",
  authorName: "Fixture",
  authorEmail: "fixture@example.invalid",
  authorDate: "2026-09-15T00:00:00Z",
  parents: [],
  refs: [],
};

describe("shared menu with Git adapter", () => {
  it("renders Chinese labels but dispatches the unchanged Git revision once", async () => {
    initializeI18n("zh-cn");
    const onClose = vi.fn();
    await act(async () => {
      render(
        <CommitContextMenu x={10} y={10} commit={commit} onClose={onClose} />,
      );
    });
    const label = screen.getByRole("menuitem", { name: "复制提交哈希" });
    await act(async () => {
      fireEvent.click(label);
    });
    expect(
      mock.request.mock.calls.filter(
        ([command]) => command === "copyToClipboard",
      ),
    ).toEqual([["copyToClipboard", { text: hash }]]);
    expect(onClose).toHaveBeenCalled();
    expect(screen.getByRole("menuitem", { name: "拣选" })).toBeTruthy();
  });
});

it("allows scrolling inside the shared menu and closes on outside scroll", async () => {
  initializeI18n("en");
  const close = vi.fn();
  await act(async () => {
    render(<CommitContextMenu x={10} y={10} commit={commit} onClose={close} />);
  });
  fireEvent.scroll(screen.getByRole("menu"));
  expect(close).not.toHaveBeenCalled();
  fireEvent.scroll(document.body);
  expect(close).toHaveBeenCalledTimes(1);
});
