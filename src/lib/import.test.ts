import { describe, expect, it } from "vitest";
import {
  autoMapping,
  defaultParseOptions,
  importSummaryText,
  mappedColumns,
  mappingError,
  parseDelimitedRecords,
  parseImportText,
  parseOptionsError,
  sourceNames,
  unmappedRequired,
  type ImportTarget,
} from "./import";

const target: ImportTarget = {
  columns: [
    {
      name: "id",
      data_type: "integer",
      nullable: false,
      has_default: true,
      generated: false,
    },
    {
      name: "Email",
      data_type: "text",
      nullable: false,
      has_default: false,
      generated: false,
    },
    {
      name: "name",
      data_type: "text",
      nullable: true,
      has_default: false,
      generated: false,
    },
    {
      name: "total",
      data_type: "integer",
      nullable: true,
      has_default: false,
      generated: true,
    },
  ],
  primary_keys: ["id"],
  transactional: true,
};

describe("import mapping", () => {
  it("matches source columns by case-insensitive name and skips the rest", () => {
    const mapping = autoMapping(["ID", "email ", "Nickname", "TOTAL"], target);
    expect(mapping).toEqual({
      ID: "id",
      "email ": "Email",
      Nickname: "",
      TOTAL: "",
    });
    expect(mappedColumns(["ID", "email ", "Nickname"], mapping)).toEqual([
      { source: "ID", target: "id" },
      { source: "email ", target: "Email" },
    ]);
  });
  it("flags NOT NULL columns without a default that are not mapped", () => {
    const mapped = [{ source: "ID", target: "id" }];
    expect(unmappedRequired(target, mapped, "append")).toEqual(["Email"]);
    expect(unmappedRequired(target, mapped, "copy")).toEqual(["Email"]);
    expect(unmappedRequired(target, mapped, "update")).toEqual([]);
  });
  it("requires a mapped primary key for Update and Append/Update", () => {
    const email = [{ source: "e", target: "Email" }];
    expect(mappingError(target, [], "append", false)).toMatch(/at least one/);
    expect(mappingError(target, email, "append", false)).toBe("");
    expect(mappingError(target, email, "upsert", false)).toMatch(
      /primary key column \(id\)/,
    );
    expect(
      mappingError(target, [{ source: "i", target: "id" }], "update", false),
    ).toMatch(/besides the primary key/);
    expect(
      mappingError({ ...target, primary_keys: [] }, email, "update", false),
    ).toMatch(/has none/);
    expect(
      mappingError(
        target,
        [...email, { source: "x", target: "Email" }],
        "append",
        false,
      ),
    ).toMatch(/mapped twice/);
    const myisam = { ...target, transactional: false };
    expect(mappingError(myisam, email, "append", false)).toMatch(
      /Continue on error/,
    );
    expect(mappingError(myisam, email, "append", true)).toBe("");
    expect(mappingError(myisam, email, "copy", true)).toMatch(/InnoDB/);
  });
  it("summarises inserted, updated, skipped and failed rows", () => {
    const base = {
      rows: 5,
      inserted: 0,
      updated: 0,
      skipped: 0,
      failed: 0,
      deleted: 0,
      errors: [],
      more_errors: 0,
    };
    expect(importSummaryText({ ...base, inserted: 1 })).toBe("Inserted 1 row.");
    expect(
      importSummaryText({ ...base, inserted: 2, updated: 3, failed: 1 }),
    ).toBe("Inserted 2 rows, updated 3 rows, 1 row failed.");
    expect(importSummaryText({ ...base, deleted: 4, inserted: 0 })).toBe(
      "Deleted 4 existing rows, inserted 0 rows.",
    );
    expect(importSummaryText({ ...base, updated: 1, skipped: 2 })).toBe(
      "Updated 1 row, skipped 2 rows.",
    );
  });
});

describe("import parsing (browser sandbox)", () => {
  it("validates delimiter, quote and NULL marker", () => {
    const csv = defaultParseOptions("csv");
    expect(parseOptionsError(csv)).toBe("");
    expect(parseOptionsError({ ...csv, delimiter: ";;" })).toMatch(/delimiter/);
    expect(parseOptionsError({ ...csv, delimiter: '"' })).toMatch(/differ/);
    expect(parseOptionsError({ ...csv, null_text: "a\nb" })).toMatch(
      /NULL marker/,
    );
    expect(
      parseOptionsError({ ...defaultParseOptions("tsv"), delimiter: '"' }),
    ).toBe("");
  });
  it("parses quoted fields with delimiters, quotes and line breaks", () => {
    expect(
      parseDelimitedRecords(
        'a,"b, ""c""",d\r\n"line1\nline2",,\n\nlast',
        ",",
        '"',
      ),
    ).toEqual([["a", 'b, "c"', "d"], ["line1\nline2", "", ""], ["last"]]);
    expect(parseDelimitedRecords("'x;y';z", ";", "'")).toEqual([["x;y", "z"]]);
  });
  it("strips the BOM, names columns and applies the NULL marker", () => {
    const parsed = parseImportText(
      "﻿id,Name,,name\n1,Café ☕,\\N,\n2,x,y,z,extra\n",
      {
        ...defaultParseOptions("csv"),
        null_text: "\\N",
      },
    );
    expect(parsed.columns).toEqual(["id", "Name", "Column 3", "name (2)"]);
    expect(parsed.rows[0]).toEqual(["1", "Café ☕", null, ""]);
    expect(parsed.rows[1]).toBeNull();
    expect(parsed.errors[0]).toMatchObject({ row: 2 });
    expect(sourceNames(["a", "A", " "])).toEqual(["a", "A (2)", "Column 3"]);
  });
  it("reads JSON arrays of objects and JSON Lines", () => {
    const array = parseImportText(
      '[{"a": 1, "b": {"x": true}}, {"c": null, "a": false}, 3]',
      defaultParseOptions("json"),
    );
    expect(array.columns).toEqual(["a", "b", "c"]);
    expect(array.rows).toEqual([
      ["1", '{"x":true}', null],
      [false, null, null],
      null,
    ]);
    expect(array.errors).toEqual([{ row: 3, message: "Not a JSON object." }]);
    const lines = parseImportText(
      '{"a": "x"}\n\n{bad\n',
      defaultParseOptions("jsonl"),
    );
    expect(lines.rows[0]).toEqual(["x"]);
    expect(lines.errors[0].row).toBe(2);
    expect(() => parseImportText("{}", defaultParseOptions("json"))).toThrow(
      /JSON Lines/,
    );
    expect(() => parseImportText("", defaultParseOptions("excel"))).toThrow(
      /desktop app/,
    );
  });
});
