import type { QueryResult } from "../types";
import { spreadsheetText } from "./sql";
export function rowsAsTsv(columns: string[], rows: unknown[][]): string {
  return [columns, ...rows]
    .map((row) =>
      row
        .map((value) => {
          const text = spreadsheetText(value);
          return /[\t\r\n"]/.test(text)
            ? '"' + text.replaceAll('"', '""') + '"'
            : text;
        })
        .join("\t"),
    )
    .join("\r\n");
}
export function rowKeys(
  result: QueryResult,
  rows: unknown[][],
): Record<string, unknown>[] {
  const keys = result.source?.primary_keys;
  if (!keys?.length)
    throw new Error(
      "This table has no primary key. Row deletion is unavailable.",
    );
  const indexes = keys.map((key) => {
    const i = result.columns.indexOf(key);
    if (i < 0 || result.columns.lastIndexOf(key) !== i)
      throw new Error(
        "Primary key columns are missing or ambiguous. Refresh the table.",
      );
    return i;
  });
  return rows.map((row) =>
    Object.fromEntries(
      keys.map((key, index) => {
        const value = row[indexes[index]];
        if (
          value == null ||
          typeof value === "object" ||
          (typeof value === "number" && !Number.isSafeInteger(value))
        )
          throw new Error(
            "This row has an unsupported primary key value. Delete it using an explicit SQL query.",
          );
        return [key, value];
      }),
    ),
  );
}
