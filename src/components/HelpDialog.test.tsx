// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import HelpDialog from "./HelpDialog";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("shows current macOS table shortcuts, searches actions and restores focus on Escape", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
  const trigger = document.createElement("button");
  document.body.append(trigger);
  trigger.focus();
  const onClose = vi.fn();
  const { unmount } = render(<HelpDialog onClose={onClose} />);
  const search = screen.getByRole("textbox", {
    name: "Search keyboard shortcuts",
  });
  expect(document.activeElement).toBe(search);
  for (const [label, keys] of [
    ["New table", "⌘N"],
    ["New query", "⌘Y"],
    ["Duplicate table", "⇧⌘D"],
    ["Transfer records", "⇧⌘T"],
    ["Find in SQL", "⌘F"],
    ["Find and replace in SQL", "⌥⌘F"],
    ["Save query (SQL editor focused)", "⌘S"],
    ["Query history", "⇧⌘H"],
    ["Saved queries", "⇧⌘O"],
  ]) {
    expect(
      within(screen.getByText(label).parentElement!).getByText(keys),
    ).toBeTruthy();
  }
  fireEvent.change(search, { target: { value: "Duplicate table" } });
  expect(screen.getByText("Duplicate table")).toBeTruthy();
  expect(screen.queryByText("Data grid")).toBeNull();
  fireEvent.change(search, { target: { value: "unmatched-command" } });
  expect(screen.getByRole("status").textContent).toContain(
    "No shortcuts match",
  );
  fireEvent.keyDown(search, { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
  unmount();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});
it("uses Windows keys and keeps keyboard focus inside the dialog", () => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue("Win32");
  render(<HelpDialog onClose={vi.fn()} />);
  expect(
    within(
      screen.getByText("Find and replace in SQL").parentElement!,
    ).getByText("Ctrl+H"),
  ).toBeTruthy();
  expect(
    within(screen.getByText("New query").parentElement!).getByText("Ctrl+Q"),
  ).toBeTruthy();
  expect(
    within(screen.getByText("Refresh table list").parentElement!).getByText(
      "F5",
    ),
  ).toBeTruthy();
  expect(screen.queryByText("Duplicate table")).toBeNull();
  const content = screen.getByLabelText("Shortcut reference");
  content.focus();
  fireEvent.keyDown(content, { key: "Tab" });
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Close help" }),
  );
  fireEvent.keyDown(document.activeElement!, { key: "Tab", shiftKey: true });
  expect(document.activeElement).toBe(content);
});
