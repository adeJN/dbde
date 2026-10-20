/** Import wizard types and rules. Field names match src-tauri/src/import.rs. */
export type ImportFormat = "csv" | "tsv" | "json" | "jsonl" | "excel";
export type ImportMode = "append" | "update" | "upsert" | "copy";
export interface ImportParseOptions {
  format: ImportFormat;
  delimiter: string;
  quote: string;
  header: boolean;
  /** A CSV/TSV/Excel text cell equal to this becomes NULL ("" makes empty cells NULL). */
  null_text: string;
  sheet?: string;
}
export interface ImportRowIssue {
  row: number;
  message: string;
}
export interface ImportPreview {
  /** Opaque ID of the file chosen in the open dialog; the webview never sees a path. */
  import_id: string;
  file_name: string;
  file_size: number;
  options: ImportParseOptions;
  sheets: string[];
  columns: string[];
  rows: (string | null)[][];
  row_errors: ImportRowIssue[];
  estimated_rows: number;
  exact_rows: boolean;
}
export interface ImportTargetColumn {
  name: string;
  data_type: string;
  nullable: boolean;
  has_default: boolean;
  generated: boolean;
}
export interface ImportTarget {
  columns: ImportTargetColumn[];
  primary_keys: string[];
  /** False for MySQL tables that cannot roll back (MyISAM and similar). */
  transactional: boolean;
}
export interface ImportColumnMapping {
  source: string;
  target: string;
}
export interface ImportRequest {
  options: ImportParseOptions;
  mapping: ImportColumnMapping[];
  mode: ImportMode;
  continue_on_error: boolean;
  batch_rows: number;
}
export interface ImportSummary {
  rows: number;
  inserted: number;
  updated: number;
  skipped: number;
  failed: number;
  deleted: number;
  errors: ImportRowIssue[];
  more_errors: number;
}
export const IMPORT_FORMATS: { value: ImportFormat; label: string }[] = [
  { value: "csv", label: "CSV" },
  { value: "tsv", label: "TSV" },
  { value: "json", label: "JSON array" },
  { value: "jsonl", label: "JSON Lines" },
  { value: "excel", label: "Excel" },
];
export const IMPORT_MODES: {
  value: ImportMode;
  label: string;
  description: string;
}[] = [
  {
    value: "append",
    label: "Append",
    description: "Insert every row as a new record.",
  },
  {
    value: "update",
    label: "Update",
    description:
      "Update existing records matched by primary key. Rows without a match are skipped and reported.",
  },
  {
    value: "upsert",
    label: "Append/Update",
    description: "Update records whose primary key exists and insert the rest.",
  },
  {
    value: "copy",
    label: "Copy",
    description:
      "Delete every existing record first, then insert the file's rows.",
  },
];
export const MAX_IMPORT_ROWS = 5_000_000;
export const MAX_ERRORS = 200;
export const SKIP = "";
export function defaultParseOptions(format: ImportFormat): ImportParseOptions {
  return {
    format,
    delimiter: format === "tsv" ? "\t" : ",",
    quote: '"',
    header: true,
    null_text: "",
  };
}
const singleAscii = (value: string) =>
  value.length === 1 && value.charCodeAt(0) < 128 && !/[\r\n\0]/.test(value);
/** Why the parse options are invalid, or "" (mirrors the backend checks). */
export function parseOptionsError(options: ImportParseOptions): string {
  const delimiter = options.format === "tsv" ? "\t" : options.delimiter;
  if (!singleAscii(delimiter))
    return "The delimiter must be a single ASCII character other than a line break.";
  if (!singleAscii(options.quote))
    return "The quote character must be a single ASCII character other than a line break.";
  if (options.quote === delimiter)
    return "The quote character must differ from the delimiter.";
  if (
    Array.from(options.null_text).length > 64 ||
    /[\r\n\0]/.test(options.null_text)
  )
    return "The NULL marker must be at most 64 characters on one line.";
  return "";
}
/** Each source column mapped to the target column with the same name, ignoring case. */
export function autoMapping(
  sources: string[],
  target: ImportTarget,
): Record<string, string> {
  const used = new Set<string>();
  const mapping: Record<string, string> = {};
  for (const source of sources) {
    const match = target.columns.find(
      (c) =>
        !c.generated &&
        !used.has(c.name) &&
        c.name.toLowerCase() === source.trim().toLowerCase(),
    );
    mapping[source] = match?.name ?? SKIP;
    if (match) used.add(match.name);
  }
  return mapping;
}
export function mappedColumns(
  sources: string[],
  mapping: Record<string, string>,
): ImportColumnMapping[] {
  return sources
    .filter((source) => mapping[source])
    .map((source) => ({ source, target: mapping[source] }));
}
/** NOT NULL columns without a default that no source column fills. */
export function unmappedRequired(
  target: ImportTarget,
  mapped: ImportColumnMapping[],
  mode: ImportMode,
): string[] {
  if (mode === "update") return [];
  const targets = new Set(mapped.map((m) => m.target));
  return target.columns
    .filter(
      (c) =>
        !c.nullable && !c.has_default && !c.generated && !targets.has(c.name),
    )
    .map((c) => c.name);
}
/** Why the import cannot run with this mapping and mode, or "". */
export function mappingError(
  target: ImportTarget,
  mapped: ImportColumnMapping[],
  mode: ImportMode,
  continueOnError: boolean,
): string {
  if (!mapped.length)
    return "Map at least one source column to a table column.";
  const targets = mapped.map((m) => m.target);
  const twice = targets.find((t, i) => targets.indexOf(t) !== i);
  if (twice) return `Column ${twice} is mapped twice.`;
  if (mode === "update" || mode === "upsert") {
    if (!target.primary_keys.length)
      return `${mode === "update" ? "Update" : "Append/Update"} matches existing rows by primary key, but this table has none.`;
    if (target.primary_keys.some((key) => !targets.includes(key)))
      return `Map every primary key column (${target.primary_keys.join(", ")}) to match existing rows.`;
    if (
      mode === "update" &&
      targets.every((t) => target.primary_keys.includes(t))
    )
      return "Map at least one column besides the primary key to update.";
  }
  if (!target.transactional && mode === "copy")
    return "Copy needs a transactional (InnoDB) table so a failure can be undone.";
  if (!target.transactional && !continueOnError)
    return "This table cannot roll back (it is not InnoDB). Enable Continue on error to import row by row.";
  return "";
}
const plural = (n: number, word: string) =>
  `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;
export function importSummaryText(summary: ImportSummary): string {
  const parts = [
    summary.deleted ? `deleted ${plural(summary.deleted, "existing row")}` : "",
    summary.inserted || (!summary.updated && !summary.skipped)
      ? `inserted ${plural(summary.inserted, "row")}`
      : "",
    summary.updated ? `updated ${plural(summary.updated, "row")}` : "",
    summary.skipped ? `skipped ${plural(summary.skipped, "row")}` : "",
    summary.failed ? `${plural(summary.failed, "row")} failed` : "",
  ].filter(Boolean);
  const text = parts.join(", ");
  return `${text.charAt(0).toUpperCase()}${text.slice(1)}.`;
}
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/* Browser sandbox parsing. The desktop app parses in Rust; these mirror its rules. */
type Cell = string | null | boolean;
export interface ParsedFile {
  columns: string[];
  /** One entry per data row; null where the row could not be parsed (see errors). */
  rows: (Cell[] | null)[];
  errors: ImportRowIssue[];
}
export function sourceNames(raw: string[]): string[] {
  const seen = new Set<string>();
  return raw.map((name, i) => {
    const clean = Array.from(name.trim())
      .filter((c) => c >= " " && c !== "\x7f")
      .slice(0, 256)
      .join("");
    const base = clean || `Column ${i + 1}`;
    let unique = base;
    for (let n = 2; seen.has(unique.toLowerCase()); n++)
      unique = `${base} (${n})`;
    seen.add(unique.toLowerCase());
    return unique;
  });
}
/** RFC 4180 records with a configurable delimiter and quote; quoted fields may span lines. */
export function parseDelimitedRecords(
  text: string,
  delimiter: string,
  quote: string,
): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let quoted = false;
  let started = false;
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quoted) {
      if (c === quote) {
        if (text[i + 1] === quote) {
          field += quote;
          i++;
        } else quoted = false;
      } else field += c;
      continue;
    }
    if (c === quote && field === "") {
      quoted = true;
      started = true;
    } else if (c === delimiter) {
      record.push(field);
      field = "";
      started = true;
    } else if (c === "\n" || c === "\r") {
      if (c === "\r" && text[i + 1] === "\n") i++;
      if (started || field) {
        record.push(field);
        records.push(record);
      }
      record = [];
      field = "";
      started = false;
    } else {
      field += c;
      started = true;
    }
  }
  if (started || field) {
    record.push(field);
    records.push(record);
  }
  return records;
}
const jsonCell = (value: unknown): Cell =>
  value === null || value === undefined
    ? null
    : typeof value === "string" || typeof value === "boolean"
      ? value
      : typeof value === "number"
        ? String(value)
        : JSON.stringify(value);
export function parseImportText(
  text: string,
  options: ImportParseOptions,
): ParsedFile {
  text = text.replace(/^﻿/, "");
  const errors: ImportRowIssue[] = [];
  if (options.format === "json" || options.format === "jsonl") {
    let items: unknown[];
    if (options.format === "json") {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch (cause) {
        throw new Error(
          `The file is not a JSON array of objects (${String(cause)}). For one object per line, choose JSON Lines.`,
        );
      }
      if (!Array.isArray(parsed))
        throw new Error(
          "The file is not a JSON array of objects. For one object per line, choose JSON Lines.",
        );
      items = parsed;
    } else {
      items = [];
      for (const line of text.split("\n")) {
        if (!line.trim()) continue;
        try {
          items.push(JSON.parse(line));
        } catch (cause) {
          items.push(new Error(`Invalid JSON: ${String(cause)}.`));
        }
      }
    }
    const columns: string[] = [];
    const objects: (Record<string, unknown> | null)[] = [];
    items.forEach((item, i) => {
      if (item && typeof item === "object" && !Array.isArray(item)) {
        if (item instanceof Error) {
          errors.push({ row: i + 1, message: item.message });
          objects.push(null);
          return;
        }
        for (const key of Object.keys(item))
          if (!columns.includes(key)) columns.push(key);
        objects.push(item as Record<string, unknown>);
      } else {
        errors.push({ row: i + 1, message: "Not a JSON object." });
        objects.push(null);
      }
    });
    return {
      columns,
      rows: objects.map((o) =>
        o ? columns.map((key) => jsonCell(o[key])) : null,
      ),
      errors,
    };
  }
  if (options.format === "excel")
    throw new Error(
      "Excel import requires the desktop app. Save the sheet as CSV to import it in the browser sandbox.",
    );
  const delimiter = options.format === "tsv" ? "\t" : options.delimiter;
  const records = parseDelimitedRecords(text, delimiter, options.quote);
  const header = options.header ? records.shift() : undefined;
  const width = Math.max(0, ...records.map((r) => r.length));
  const columns = header
    ? sourceNames(header)
    : Array.from({ length: width }, (_, i) => `Column ${i + 1}`);
  return {
    columns,
    rows: records.map((record, i) => {
      // Trailing delimiters are tolerated; real extra values mean broken quoting.
      if (
        header &&
        record.slice(columns.length).some((field) => field !== "")
      ) {
        errors.push({
          row: i + 1,
          message: `Has ${record.length} fields but the header has ${columns.length}. Check the delimiter and quotes.`,
        });
        return null;
      }
      return record.map((field) =>
        field === options.null_text ? null : field,
      );
    }),
    errors,
  };
}
