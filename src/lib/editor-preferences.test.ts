// @vitest-environment jsdom
import { it, expect, afterEach, vi } from "vitest";
import {
  readEditorPreferences,
  saveEditorPreferences,
  defaultEditorPreferences,
} from "./editor-preferences";
afterEach(() => vi.unstubAllGlobals());
it("keeps only bounded known editor settings", () => {
  vi.stubGlobal("localStorage", {
    getItem: () =>
      JSON.stringify({
        fontSize: 9999,
        tabSize: 8,
        wordWrap: false,
        minimap: true,
        lineNumbers: false,
      }),
  });
  expect(readEditorPreferences()).toEqual({
    ...defaultEditorPreferences,
    wordWrap: false,
    minimap: true,
    lineNumbers: false,
  });
});
it("survives unavailable or invalid storage", () => {
  vi.stubGlobal("localStorage", {
    getItem: () => "invalid JSON",
    setItem: () => {
      throw new Error("Full");
    },
  });
  expect(readEditorPreferences()).toEqual(defaultEditorPreferences);
  expect(() => saveEditorPreferences(defaultEditorPreferences)).not.toThrow();
});
