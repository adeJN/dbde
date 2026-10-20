import { describe, expect, it, vi } from "vitest";
import {
  libraryShortcutFromKey,
  libraryShortcutLabel,
} from "./library-shortcuts";
import { appendSql, insertIntoEditor } from "./editor-insert";

const key = (patch: Partial<Parameters<typeof libraryShortcutFromKey>[0]>) => ({
  key: "h",
  ctrlKey: false,
  metaKey: false,
  shiftKey: true,
  altKey: false,
  ...patch,
});

describe("library shortcuts", () => {
  it("uses Cmd+Shift on macOS and Ctrl+Shift elsewhere", () => {
    expect(libraryShortcutFromKey(key({ metaKey: true, key: "H" }), true)).toBe(
      "history",
    );
    expect(
      libraryShortcutFromKey(key({ ctrlKey: true }), true),
    ).toBeUndefined();
    expect(
      libraryShortcutFromKey(key({ ctrlKey: true, key: "O" }), false),
    ).toBe("queries");
    expect(
      libraryShortcutFromKey(key({ ctrlKey: true, shiftKey: false }), false),
    ).toBeUndefined();
    expect(
      libraryShortcutFromKey(key({ ctrlKey: true, altKey: true }), false),
    ).toBeUndefined();
    expect(
      libraryShortcutFromKey(key({ ctrlKey: true, key: "s" }), false),
    ).toBeUndefined();
    expect(libraryShortcutLabel("history", true)).toBe("⇧⌘H");
    expect(libraryShortcutLabel("queries", false)).toBe("Ctrl+Shift+O");
  });
});

describe("editor insertion", () => {
  const range = {
    startLineNumber: 1,
    startColumn: 1,
    endLineNumber: 1,
    endColumn: 1,
  };
  it("inserts snippets through the snippet controller and text at the selection", () => {
    const insert = vi.fn();
    const executeEdits = vi.fn(() => true);
    const editor = {
      focus: vi.fn(),
      getSelection: () => range,
      executeEdits,
      getContribution: () => ({ insert }),
    };
    expect(insertIntoEditor(editor, "SELECT ${1:x}", true)).toBe(true);
    expect(insert).toHaveBeenCalledWith("SELECT ${1:x}");
    expect(executeEdits).not.toHaveBeenCalled();
    insertIntoEditor(editor, "SELECT 1");
    expect(executeEdits).toHaveBeenCalledWith("dbde-insert", [
      { range, text: "SELECT 1", forceMoveMarkers: true },
    ]);
    expect(insertIntoEditor(null, "x")).toBe(false);
  });
  it("appends on a new paragraph when no editor is shown", () => {
    expect(appendSql("", "SELECT 1")).toBe("SELECT 1");
    expect(appendSql("SELECT 1;\n\n", "SELECT 2")).toBe(
      "SELECT 1;\n\nSELECT 2",
    );
  });
});
