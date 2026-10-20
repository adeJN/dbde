import { describe, expect, it } from "vitest";
import {
  defaultExportOptions,
  exportCellText,
  exportOptionsError,
  exportSummaryText,
  exportText,
  type ExportOptions,
} from "./export";

const options = (patch: Partial<ExportOptions> = {}): ExportOptions => ({
  ...defaultExportOptions(["id", "name", "note"]),
  ...patch,
});
const rows = [
  [1, 'say "hi", ok', null],
  [2, "line\nbreak", ""],
  [3, "=SUM(A1)", { hex: "00ff" }],
  [4, "-12.50", "Café ☕"],
];

describe("export formatting (sandbox and validation)", () => {
  it("writes CSV like the backend: BOM, minimal quoting, NULL vs empty, formula protection", () => {
    expect(exportText(options(), rows, "sqlite")).toBe(
      "﻿id,name,note\r\n" +
        '1,"say ""hi"", ok",\r\n' +
        '2,"line\nbreak",""\r\n' +
        "3,'=SUM(A1),0x00ff\r\n" +
        "4,-12.50,Café ☕\r\n",
    );
    expect(
      exportText(
        options({
          bom: false,
          header: false,
          delimiter: ";",
          quote: "'",
          null_text: "NULL",
          protect_formulas: false,
        }),
        rows.slice(0, 3),
        "sqlite",
      ),
    ).toBe(
      "1;say \"hi\", ok;NULL\r\n2;'line\nbreak';''\r\n3;=SUM(A1);0x00ff\r\n",
    );
    expect(
      exportText(
        options({ format: "tsv", bom: false }),
        [[1, "a\tb", null]],
        "sqlite",
      ),
    ).toBe('id\tname\tnote\r\n1\t"a\tb"\t\r\n');
  });
  it("writes JSON as an array of objects and SQL in batches per dialect", () => {
    const json = exportText(options({ format: "json" }), rows, "sqlite");
    expect(JSON.parse(json)[2]).toEqual({
      id: 3,
      name: "=SUM(A1)",
      note: "0x00ff",
    });
    expect(json.startsWith('[\n{"id":1,')).toBe(true);
    expect(exportText(options({ format: "json" }), [], "sqlite")).toBe("[]\n");
    expect(
      exportText(
        options({ format: "sql", batch_size: 3, columns: ["id", "name"] }),
        [
          [1, "it's \\"],
          [2, null],
          [3, true],
          [4, { hex: "beef" }],
        ],
        "mysql",
        "`t`",
        "CREATE TABLE t (id int);\n",
      ),
    ).toBe(
      "CREATE TABLE t (id int);\n\n" +
        "INSERT INTO `t` (`id`, `name`) VALUES\n  (1, 'it''s \\\\'),\n  (2, NULL),\n  (3, TRUE);\n" +
        "INSERT INTO `t` (`id`, `name`) VALUES (4, X'beef');\n",
    );
    expect(() =>
      exportText(options({ format: "xlsx" }), rows, "sqlite"),
    ).toThrow(/desktop app/);
  });
  it("validates options the same way as the backend", () => {
    expect(exportOptionsError(options())).toBe("");
    expect(exportOptionsError(options({ columns: [] }))).toMatch(
      /at least one/,
    );
    expect(exportOptionsError(options({ delimiter: ";;" }))).toMatch(/single/);
    expect(exportOptionsError(options({ delimiter: '"' }))).toMatch(/differ/);
    expect(exportOptionsError(options({ format: "tsv", delimiter: '"' }))).toBe(
      "",
    );
    expect(exportOptionsError(options({ null_text: "a\nb" }))).toMatch(/NULL/);
    expect(
      exportOptionsError(options({ format: "sql", batch_size: 0 })),
    ).toMatch(/1 and 1,000/);
    expect(exportOptionsError(options({ create_table: true }))).toMatch(/SQL/);
    expect(exportCellText({ k: [1] })).toBe('{"k":[1]}');
    expect(exportCellText(false)).toBe("false");
  });
  it("summarises the result for the success notice", () => {
    expect(
      exportSummaryText({
        path: "/tmp/a.csv",
        rows: 1234,
        sheets: 1,
        truncated_cells: 0,
      }),
    ).toBe(`Exported ${(1234).toLocaleString()} rows to /tmp/a.csv.`);
    expect(
      exportSummaryText({
        path: "/tmp/a.xlsx",
        rows: 1,
        sheets: 2,
        truncated_cells: 1,
      }),
    ).toMatch(
      /1 row across 2 sheets .* to \/tmp\/a\.xlsx\. 1 cell was shortened/,
    );
  });
});
