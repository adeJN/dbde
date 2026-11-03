import type { editor } from "monaco-editor";
import type { Driver } from "../types";
export async function formatEditorSql(
  instance: editor.IStandaloneCodeEditor | null,
  driver: Driver,
) {
  const model = instance?.getModel();
  if (!instance || !model) return;
  const selection = instance.getSelection();
  const range =
    selection && !selection.isEmpty() ? selection : model.getFullModelRange();
  const text = model.getValueInRange(range),
    version = model.getVersionId();
  const { format } = await import("sql-formatter");
  const formatted = format(text, {
    language:
      driver === "postgres"
        ? "postgresql"
        : driver === "mysql"
          ? "mysql"
          : "sqlite",
    tabWidth: model.getOptions().tabSize,
  });
  if (
    model.isDisposed() ||
    instance.getModel() !== model ||
    model.getVersionId() !== version
  )
    throw new Error("SQL changed while formatting. Try again.");
  instance.pushUndoStop();
  instance.executeEdits("dbde.format", [
    { range, text: formatted, forceMoveMarkers: true },
  ]);
  instance.pushUndoStop();
  instance.focus();
}
