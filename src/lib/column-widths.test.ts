import { expect, it } from "vitest";
import {
  MAX_COLUMN_WIDTH,
  MIN_COLUMN_WIDTH,
  tableColumnWidths,
} from "./column-widths";
const measure = (text: string) => text.length * 8;

it("sizes each field independently using fetched contents", () => {
  expect(
    tableColumnWidths(
      ["id", "name"],
      [[1, "A moderately long customer name"]],
      [],
      measure,
    ),
  ).toEqual([MIN_COLUMN_WIDTH, 272]);
});
it("includes names and data types even when a table has no records", () => {
  const [width] = tableColumnWidths(
    ["x"],
    [],
    [{ name: "x", data_type: "timestamp with time zone", nullable: true }],
    measure,
  );
  expect(width).toBe(232);
});
it("caps long text and headers instead of expanding all columns", () => {
  expect(
    tableColumnWidths(
      ["x".repeat(200), "note", "id"],
      [[1, "large".repeat(5000), 2]],
      [],
      measure,
    ),
  ).toEqual([MAX_COLUMN_WIDTH, MAX_COLUMN_WIDTH, MIN_COLUMN_WIDTH]);
});
it("uses formatted NULL, JSON and multiline values", () => {
  const measured: string[] = [];
  tableColumnWidths(
    ["value"],
    [[null], [{ name: "A" }], ["line one\nline two"]],
    [],
    (text) => {
      measured.push(text);
      return text.length * 8;
    },
  );
  expect(measured).toContain("NULL");
  expect(measured).toContain('{"name":"A"}');
  expect(measured).toContain("line one line two");
});
