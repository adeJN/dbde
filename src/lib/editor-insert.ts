/** Minimal slice of a Monaco editor used to insert text at the cursor. */
export interface InsertableEditor {
  focus(): void;
  getSelection(): {
    startLineNumber: number;
    startColumn: number;
    endLineNumber: number;
    endColumn: number;
  } | null;
  executeEdits(
    source: string,
    edits: {
      range: {
        startLineNumber: number;
        startColumn: number;
        endLineNumber: number;
        endColumn: number;
      };
      text: string;
      forceMoveMarkers?: boolean;
    }[],
  ): boolean;
  getContribution(id: string): unknown;
}

/**
 * Inserts at the cursor (replacing a selection). A snippet body goes through
 * Monaco's snippet controller so its placeholders become tab stops.
 */
export function insertIntoEditor(
  editor: InsertableEditor | null | undefined,
  text: string,
  asSnippet = false,
) {
  if (!editor) return false;
  editor.focus();
  const controller = asSnippet
    ? (editor.getContribution("snippetController2") as {
        insert?: (template: string) => void;
      } | null)
    : null;
  if (controller?.insert) {
    controller.insert(text);
    return true;
  }
  const range = editor.getSelection();
  if (!range) return false;
  return editor.executeEdits("dbde-insert", [
    { range, text, forceMoveMarkers: true },
  ]);
}

/** Appends text to SQL when no editor is mounted, on its own line. */
export function appendSql(query: string, text: string) {
  if (!query.trim()) return text;
  return `${query.replace(/\s*$/, "")}\n\n${text}`;
}
