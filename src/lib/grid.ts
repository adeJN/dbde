import type { Driver, TableInfo } from "../types";
import {
  displayValue,
  qualifiedName,
  quoteIdentifier,
  spreadsheetText,
} from "./sql";

export interface CellPosition {
  row: number;
  column: number;
}
/** Inclusive rectangle between two cells, whichever corner each one is. */
export function cellRange(a: CellPosition, b: CellPosition) {
  return {
    top: Math.min(a.row, b.row),
    bottom: Math.max(a.row, b.row),
    left: Math.min(a.column, b.column),
    right: Math.max(a.column, b.column),
  };
}
export type CellRange = ReturnType<typeof cellRange>;
export const inRange = (range: CellRange, row: number, column: number) =>
  row >= range.top &&
  row <= range.bottom &&
  column >= range.left &&
  column <= range.right;

/**
 * Parses clipboard text from spreadsheets and other grids: tab-separated cells, CR/LF
 * rows, and Excel-style quoting for cells that contain tabs, newlines or quotes.
 */
export function parseClipboardTable(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let i = 0;
  let quoted = false;
  // Whether the current row has any content, including a quoted empty cell ("").
  let started = false;
  const endCell = () => {
    row.push(cell);
    cell = "";
  };
  while (i < text.length) {
    const char = text[i];
    if (quoted) {
      if (char === '"' && text[i + 1] === '"') {
        cell += '"';
        i += 2;
        continue;
      }
      if (char === '"') quoted = false;
      else cell += char;
      i++;
      continue;
    }
    if (char !== "\r" && char !== "\n") started = true;
    if (char === '"' && cell === "") quoted = true;
    else if (char === "\t") endCell();
    else if (char === "\r" || char === "\n") {
      endCell();
      rows.push(row);
      row = [];
      started = false;
      if (char === "\r" && text[i + 1] === "\n") i++;
    } else cell += char;
    i++;
  }
  // A trailing newline (as spreadsheets add) does not create an empty last row; an
  // empty last row is written as "" by tsv() so it survives the round trip.
  if (started) {
    endCell();
    rows.push(row);
  }
  return rows.length ? rows : [[""]];
}

/** A SQL literal for a value shown in the grid, in the given dialect. */
export function sqlLiteral(value: unknown, driver: Driver): string {
  if (value == null) return "NULL";
  if (typeof value === "number" || typeof value === "bigint")
    return String(value);
  if (typeof value === "boolean")
    return driver === "sqlite" ? (value ? "1" : "0") : value ? "TRUE" : "FALSE";
  if (typeof value === "object" && "hex" in value) {
    const hex = String((value as { hex: unknown }).hex);
    return driver === "postgres" ? `'\\x${hex}'::bytea` : `X'${hex}'`;
  }
  const text = displayValue(value);
  // MySQL treats backslashes in strings as escapes by default; the others do not.
  const escaped =
    driver === "mysql"
      ? text.replaceAll("\\", "\\\\").replaceAll("'", "''")
      : text.replaceAll("'", "''");
  return `'${escaped}'`;
}

export function insertStatements(
  table: TableInfo,
  driver: Driver,
  columns: string[],
  rows: unknown[][],
) {
  const target = qualifiedName(table, driver);
  const names = columns.map((c) => quoteIdentifier(c, driver)).join(", ");
  return rows
    .map(
      (row) =>
        `INSERT INTO ${target} (${names}) VALUES (${row.map((v) => sqlLiteral(v, driver)).join(", ")});`,
    )
    .join("\n");
}

/**
 * UPDATE statements that set every non-key column. Rows are identified by the primary
 * key, or by all column values when the table has none (as Navicat does).
 */
export function updateStatements(
  table: TableInfo,
  driver: Driver,
  columns: string[],
  primaryKeys: string[],
  rows: unknown[][],
) {
  const target = qualifiedName(table, driver);
  const keyColumns = primaryKeys.length ? primaryKeys : columns;
  return rows
    .map((row) => {
      const value = (column: string) => row[columns.indexOf(column)];
      const sets = columns
        .filter((c) => !primaryKeys.includes(c))
        .map(
          (c) =>
            `${quoteIdentifier(c, driver)} = ${sqlLiteral(value(c), driver)}`,
        );
      const where = keyColumns.map((c) =>
        value(c) == null
          ? `${quoteIdentifier(c, driver)} IS NULL`
          : `${quoteIdentifier(c, driver)} = ${sqlLiteral(value(c), driver)}`,
      );
      return `UPDATE ${target} SET ${sets.join(", ")} WHERE ${where.join(" AND ")};`;
    })
    .join("\n");
}

/**
 * A row whose only cell is empty would be a blank line, which readers (this parser,
 * spreadsheets) drop at the end of the text. A quoted empty cell keeps the row.
 */
export const keepEmptyLine = (line: string) => (line === "" ? '""' : line);
/**
 * Tab-separated text with optional headers. Cells with tabs or newlines are quoted, and
 * formula-like text is neutralised exactly as for other clipboard copies.
 */
export function tsv(
  columns: string[],
  rows: unknown[][],
  part: "data" | "names" | "both",
) {
  const cell = (value: unknown) => {
    const text = spreadsheetText(value);
    return /[\t\r\n"]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
  };
  const lines = [
    ...(part === "data" ? [] : [columns.map(cell).join("\t")]),
    ...(part === "names" ? [] : rows.map((row) => row.map(cell).join("\t"))),
  ];
  return lines.map(keepEmptyLine).join("\r\n");
}
