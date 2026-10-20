import type { Driver } from "../types";
import { quoteIdentifier, spreadsheetText } from "./sql";
import { sqlLiteral } from "./grid";

export type ExportFormat = "csv" | "tsv" | "json" | "xlsx" | "sql";
/** all: the whole table · filtered: the grid's filters and sort · selected: ticked rows · fetched: a query's rows. */
export type ExportScope = "all" | "filtered" | "selected" | "fetched";
/** Field names match the Rust `ExportOptions` (src-tauri/src/export.rs). */
export interface ExportOptions {
  format: ExportFormat;
  columns: string[];
  header: boolean;
  delimiter: string;
  quote: string;
  null_text: string;
  protect_formulas: boolean;
  bom: boolean;
  create_table: boolean;
  batch_size: number;
  table_name?: string;
}
export interface ExportSummary {
  path: string;
  rows: number;
  sheets: number;
  truncated_cells: number;
}
export const EXPORT_FORMATS: {
  value: ExportFormat;
  label: string;
  extension: string;
}[] = [
  { value: "csv", label: "CSV", extension: "csv" },
  { value: "tsv", label: "TSV", extension: "tsv" },
  { value: "json", label: "JSON", extension: "json" },
  { value: "xlsx", label: "Excel (.xlsx)", extension: "xlsx" },
  { value: "sql", label: "SQL INSERT", extension: "sql" },
];
export const MAX_FETCHED_EXPORT_ROWS = 50_000;
export function defaultExportOptions(columns: string[]): ExportOptions {
  return {
    format: "csv",
    columns,
    header: true,
    delimiter: ",",
    quote: '"',
    null_text: "",
    protect_formulas: true,
    bom: true,
    create_table: false,
    batch_size: 100,
  };
}
const singleChar = (value: string) =>
  Array.from(value).length === 1 && !/[\r\n\0]/.test(value);
/** Why the options cannot be exported, or "" (mirrors the backend checks). */
export function exportOptionsError(options: ExportOptions): string {
  if (!options.columns.length) return "Choose at least one column to export.";
  const delimiter = options.format === "tsv" ? "\t" : options.delimiter;
  if (!singleChar(delimiter))
    return "The delimiter must be a single character other than a line break.";
  if (!singleChar(options.quote))
    return "The quote character must be a single character other than a line break.";
  if (options.quote === delimiter)
    return "The quote character must differ from the delimiter.";
  if (
    Array.from(options.null_text).length > 64 ||
    /[\r\n\0]/.test(options.null_text)
  )
    return "NULL text must be at most 64 characters on one line.";
  if (
    !Number.isInteger(options.batch_size) ||
    options.batch_size < 1 ||
    options.batch_size > 1000
  )
    return "Rows per INSERT must be between 1 and 1,000.";
  if (options.create_table && options.format !== "sql")
    return "CREATE TABLE is only written by SQL exports.";
  return "";
}
const isBinary = (value: unknown): value is { hex: string } =>
  value !== null &&
  typeof value === "object" &&
  "hex" in value &&
  typeof (value as { hex: unknown }).hex === "string";
/** The text written for a cell, or null for NULL; binary becomes 0x-prefixed hex. */
export function exportCellText(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value;
  if (isBinary(value)) return "0x" + value.hex;
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
function field(text: string, delimiter: string, quote: string) {
  return text === "" ||
    text.includes(delimiter) ||
    text.includes(quote) ||
    /[\r\n]/.test(text)
    ? quote + text.replaceAll(quote, quote + quote) + quote
    : text;
}
/**
 * The whole export as text (CSV, TSV, JSON or SQL). The desktop app streams the same
 * output from Rust; this builds it in memory for the browser sandbox.
 */
export function exportText(
  options: ExportOptions,
  rows: unknown[][],
  driver: Driver,
  sqlTarget = "",
  ddl = "",
): string {
  if (options.format === "xlsx")
    throw new Error("Excel export requires the desktop app.");
  if (options.format === "json") {
    if (!rows.length) return "[]\n";
    const names = options.columns.map((name) => JSON.stringify(name));
    return (
      "[\n" +
      rows
        .map(
          (row) =>
            "{" +
            row
              .map(
                (value, i) =>
                  `${names[i]}:${JSON.stringify(isBinary(value) ? "0x" + value.hex : (value ?? null))}`,
              )
              .join(",") +
            "}",
        )
        .join(",\n") +
      "\n]\n"
    );
  }
  if (options.format === "sql") {
    const names = options.columns
      .map((name) => quoteIdentifier(name, driver))
      .join(", ");
    const statements: string[] = [];
    for (let i = 0; i < rows.length; i += options.batch_size) {
      const tuples = rows
        .slice(i, i + options.batch_size)
        .map((row) => `(${row.map((v) => sqlLiteral(v, driver)).join(", ")})`);
      statements.push(
        tuples.length === 1
          ? `INSERT INTO ${sqlTarget} (${names}) VALUES ${tuples[0]};\n`
          : `INSERT INTO ${sqlTarget} (${names}) VALUES\n  ${tuples.join(",\n  ")};\n`,
      );
    }
    return (ddl ? ddl.trimEnd() + "\n\n" : "") + statements.join("");
  }
  const delimiter = options.format === "tsv" ? "\t" : options.delimiter;
  const protect = (text: string) =>
    options.protect_formulas ? spreadsheetText(text) : text;
  const line = (cells: string[]) => cells.join(delimiter) + "\r\n";
  const out = options.header
    ? [
        line(
          options.columns.map((name) =>
            field(protect(name), delimiter, options.quote),
          ),
        ),
      ]
    : [];
  for (const row of rows)
    out.push(
      line(
        row.map((value) => {
          const text = exportCellText(value);
          if (text === null)
            return options.null_text
              ? field(options.null_text, delimiter, options.quote)
              : "";
          return field(protect(text), delimiter, options.quote);
        }),
      ),
    );
  return (options.bom ? "﻿" : "") + out.join("");
}
export function exportSummaryText(summary: ExportSummary): string {
  const rows = `${summary.rows.toLocaleString()} row${summary.rows === 1 ? "" : "s"}`;
  const sheets =
    summary.sheets > 1
      ? ` across ${summary.sheets} sheets (Excel holds 1,048,576 rows per sheet)`
      : "";
  const truncated = summary.truncated_cells
    ? `. ${summary.truncated_cells.toLocaleString()} cell${summary.truncated_cells === 1 ? " was" : "s were"} shortened to Excel's 32,767-character limit`
    : "";
  return `Exported ${rows}${sheets} to ${summary.path}${truncated}.`;
}
