// @vitest-environment jsdom
import { expect, it } from "vitest";
import { tableShortcut, tableShortcutLabel } from "./table-shortcuts";
const key = (value: string, modifiers = {}) => ({
  key: value,
  metaKey: false,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  ...modifiers,
});
it("matches Navicat macOS object actions and keeps Windows query distinct", () => {
  for (const [letter, action] of Object.entries({
    n: "new",
    d: "design",
    r: "refresh",
    y: "query",
    c: "copy",
    v: "paste",
    a: "all",
  })) {
    expect(tableShortcut(key(letter, { metaKey: true }), true)).toBe(action);
    expect(tableShortcut(key(letter, { ctrlKey: true }), true)).toBeUndefined();
  }
  expect(tableShortcut(key("D", { metaKey: true, shiftKey: true }), true)).toBe(
    "duplicate",
  );
  expect(tableShortcut(key("T", { metaKey: true, shiftKey: true }), true)).toBe(
    "transfer",
  );
  expect(tableShortcut(key("q", { ctrlKey: true }), false)).toBe("query");
  expect(tableShortcut(key("F5"), false)).toBe("refresh");
  for (const letter of ["y", "r", "o"])
    expect(
      tableShortcut(key(letter, { ctrlKey: true }), false),
    ).toBeUndefined();
  expect(
    tableShortcut(key("T", { ctrlKey: true, shiftKey: true }), false),
  ).toBeUndefined();
  expect(tableShortcutLabel("query", false)).toBe("Ctrl+Q");
  expect(tableShortcutLabel("refresh", true)).toBe("⌘R");
});
it("does not steal full screen, query-object, replace, or OS modified commands", () => {
  for (const modifiers of [
    { metaKey: true, ctrlKey: true },
    { metaKey: true, altKey: true },
    { metaKey: true, shiftKey: true },
  ]) {
    for (const letter of ["f", "y", "r", "n", "v"])
      expect(tableShortcut(key(letter, modifiers), true)).toBeUndefined();
  }
  expect(tableShortcut(key("o", { metaKey: true }), true)).toBeUndefined();
});
