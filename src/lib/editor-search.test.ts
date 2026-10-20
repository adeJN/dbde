// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import type { editor } from "monaco-editor";
import { editorSearchShortcut, openEditorSearch } from "./editor-search";

afterEach(() => vi.restoreAllMocks());

it.each(["find", "replace"] as const)(
  "opens %s in the active editor after focusing it",
  async (action) => {
    const calls: string[] = [];
    const run = vi.fn(() => {
      calls.push("run");
      return Promise.resolve();
    });
    const getAction = vi.fn(() => ({ run }));
    const instance = {
      getModel: () => ({}),
      focus: () => calls.push("focus"),
      getAction,
    } as unknown as editor.IStandaloneCodeEditor;
    await openEditorSearch(instance, action);
    expect(getAction).toHaveBeenCalledWith(
      action === "find"
        ? "actions.find"
        : "editor.action.startFindReplaceAction",
    );
    expect(calls).toEqual(["focus", "run"]);
  },
);

it("ignores an unmounted editor", async () => {
  await expect(openEditorSearch(null, "replace")).resolves.toBeUndefined();
  const focus = vi.fn();
  await openEditorSearch(
    { getModel: () => null, focus } as unknown as editor.IStandaloneCodeEditor,
    "find",
  );
  expect(focus).not.toHaveBeenCalled();
});

it.each([
  ["MacIntel", "⌘F", "⌥⌘F"],
  ["Win32", "Ctrl+F", "Ctrl+H"],
])("shows platform shortcuts on %s", (platform, find, replace) => {
  vi.spyOn(navigator, "platform", "get").mockReturnValue(platform);
  expect(editorSearchShortcut("find")).toBe(find);
  expect(editorSearchShortcut("replace")).toBe(replace);
});
