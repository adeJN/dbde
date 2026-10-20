import type { ColumnInfo } from "../types";
import { displayValue } from "./sql";

export const MIN_COLUMN_WIDTH = 96;
export const MAX_COLUMN_WIDTH = 300;
type TextKind = "name" | "type" | "value";
type MeasureText = (text: string, kind: TextKind) => number;

let context: CanvasRenderingContext2D | null | undefined;
function measureText(text: string, kind: TextKind): number {
  // Canvas is unavailable in non-browser/test environments.
  if (context === undefined) {
    context =
      typeof CanvasRenderingContext2D === "undefined"
        ? null
        : document.createElement("canvas").getContext("2d");
  }
  if (!context)
    return Array.from(text).reduce(
      (width, char) => width + (char.codePointAt(0)! > 255 ? 14 : 7.3),
      0,
    );
  context.font =
    kind === "name"
      ? '600 11px "DM Sans", -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif'
      : kind === "type"
        ? '10px ui-monospace, "SFMono-Regular", Consolas, monospace'
        : '11px "SFMono-Regular", Consolas, monospace';
  return context.measureText(text).width;
}

/** Size from fetched data, so filtering and typing do not shift the grid. */
export function tableColumnWidths(
  columns: string[],
  rows: unknown[][],
  metadata: ColumnInfo[] = [],
  measure: MeasureText = measureText,
): number[] {
  const types = new Map(
    metadata.map((column) => [column.name, column.data_type]),
  );
  return columns.map((name, index) => {
    let width = Math.max(
      MIN_COLUMN_WIDTH,
      measure(name.slice(0, 256), "name") + 40,
      measure((types.get(name) ?? "").slice(0, 256), "type") + 40,
    );
    for (const row of rows) {
      if (width >= MAX_COLUMN_WIDTH) break;
      // Bound measurement of long text/JSON while still reaching the width cap.
      const text = displayValue(row[index])
        .slice(0, 256)
        .replace(/[\r\n\t]/g, " ");
      width = Math.max(width, measure(text, "value") + 24);
    }
    return Math.min(MAX_COLUMN_WIDTH, Math.ceil(width));
  });
}
