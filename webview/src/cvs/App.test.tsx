import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
} from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const fixture = vi.hoisted(() => ({
  state: undefined as unknown,
  messages: [] as Array<Record<string, unknown>>,
  api: {
    getState: () => fixture.state,
    setState: vi.fn(),
    postMessage: (message: Record<string, unknown>) =>
      fixture.messages.push(message),
  },
}));
vi.mock("../shared/bridge/vscode-api", () => ({
  getVSCodeApi: () => fixture.api,
}));

import { CvsApp } from "./App";

function emit(data: Record<string, unknown>) {
  act(() => window.dispatchEvent(new MessageEvent("message", { data })));
}
describe("CVS four-column page", () => {
  beforeEach(() => {
    fixture.state = {
      version: 1,
      history: { selected: "one.txt", selectedRevision: "1.1", collapsed: {} },
      commit: { checked: ["two.txt"], message: "draft" },
      layout: {
        version: 1,
        widths: { commit: 280, navigation: 180, detail: 280 },
        collapsed: { commit: false, navigation: false, detail: false },
      },
    };
    fixture.messages = [];
    fixture.api.setState.mockReset();
    document.body.innerHTML = '<div id="root" data-language="en"></div>';
  });
  afterEach(cleanup);
  it("keeps commit state through history failure and keeps file history selection independent", () => {
    render(<CvsApp />);
    emit({
      type: "init",
      language: "en",
      capabilities: { commit: true },
      repository: { kind: "cvs", root: "/fixture" },
    });
    emit({
      type: "state",
      files: [
        { newPath: "one.txt", state: "Up-to-date", entryRevision: "1.1" },
        { newPath: "two.txt", state: "Locally Modified", entryRevision: "1.1" },
      ],
    });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "survives" },
    });
    emit({ type: "error", message: "history failed" });
    expect((screen.getByRole("textbox") as HTMLTextAreaElement).value).toBe(
      "survives",
    );
    expect((screen.getByRole("checkbox") as HTMLInputElement).checked).toBe(
      true,
    );
    expect(screen.getByRole("alert").textContent).toBe("history failed");
  });
  it("uses host locale before first render and guards commit shortcut while busy", () => {
    const root = document.getElementById("root");
    if (!root) throw new Error("missing test root");
    root.dataset.language = "zh-tw";
    render(<CvsApp />);
    expect(screen.getByText("提交")).toBeTruthy();
    emit({
      type: "init",
      language: "de",
      capabilities: { commit: true },
      repository: { kind: "cvs", root: "/fixture" },
    });
    emit({
      type: "state",
      files: [
        { newPath: "two.txt", state: "Locally Modified", entryRevision: "1.1" },
      ],
    });
    fireEvent.change(screen.getByRole("textbox"), {
      target: { value: "draft" },
    });
    emit({ type: "busy", busy: true });
    fireEvent.keyDown(screen.getByRole("textbox"), {
      key: "Enter",
      ctrlKey: true,
    });
    expect(
      fixture.messages.filter((message) => message.type === "commit"),
    ).toHaveLength(0);
    expect(screen.getByText("Commit")).toBeTruthy();
  });
});
