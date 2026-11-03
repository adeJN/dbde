import { it, expect, vi, beforeEach } from "vitest";
import type { editor } from "monaco-editor";
const { format } = vi.hoisted(() => ({
  format: vi.fn(() => "SELECT\n  id\nFROM users"),
}));
vi.mock("sql-formatter", () => ({ format }));
import { formatEditorSql } from "./editor-format";
beforeEach(() => format.mockClear());
function setup() {
  let version = 1;
  const range = {
    startLineNumber: 2,
    startColumn: 1,
    endLineNumber: 2,
    endColumn: 10,
    isEmpty: () => false,
  };
  const model = {
    getValueInRange: vi.fn(() => "select id"),
    getVersionId: () => version,
    getOptions: () => ({ tabSize: 4 }),
    isDisposed: () => false,
    getFullModelRange: () => ({
      startLineNumber: 1,
      startColumn: 1,
      endLineNumber: 5,
      endColumn: 1,
    }),
  };
  const instance = {
    getModel: () => model,
    getSelection: () => range,
    pushUndoStop: vi.fn(),
    executeEdits: vi.fn(),
    focus: vi.fn(),
  } as unknown as editor.IStandaloneCodeEditor;
  return { instance, model, range, change: () => version++ };
}
it("formats only the selection, keeps undo boundaries and uses the current dialect", async () => {
  const { instance, range } = setup();
  await formatEditorSql(instance, "postgres");
  expect(format).toHaveBeenCalledWith("select id", {
    language: "postgresql",
    tabWidth: 4,
  });
  expect(instance.executeEdits).toHaveBeenCalledWith("dbde.format", [
    expect.objectContaining({ range, text: "SELECT\n  id\nFROM users" }),
  ]);
  expect(instance.pushUndoStop).toHaveBeenCalledTimes(2);
});
it("does not overwrite edits made while the formatter loads", async () => {
  const { instance, change } = setup();
  const pending = formatEditorSql(instance, "mysql");
  change();
  await expect(pending).rejects.toThrow("SQL changed");
  expect(instance.executeEdits).not.toHaveBeenCalled();
});
it("ignores an unmounted editor", async () => {
  await formatEditorSql(null, "sqlite");
  expect(format).not.toHaveBeenCalled();
});
