import { describe, expect, it } from "vitest";
import {
  cellRange,
  inRange,
  insertStatements,
  parseClipboardTable,
  sqlLiteral,
  tsv,
  updateStatements,
} from "./grid";
const table = { name: "people", schema: "app", kind: "table" };
describe("clipboard tables", () => {
  it("parses spreadsheet TSV including quoted tabs, newlines and quotes", () => {
    expect(parseClipboardTable("a\tb\r\nc\td\r\n")).toEqual([
      ["a", "b"],
      ["c", "d"],
    ]);
    expect(parseClipboardTable('"x\ty"\t"line1\nline2"\t"say ""hi"""')).toEqual(
      [["x\ty", "line1\nline2", 'say "hi"']],
    );
    expect(parseClipboardTable("single")).toEqual([["single"]]);
    expect(parseClipboardTable("a\t\tc")).toEqual([["a", "", "c"]]);
  });
  it("builds ranges from any two corners", () => {
    const range = cellRange({ row: 4, column: 1 }, { row: 2, column: 3 });
    expect(range).toEqual({ top: 2, bottom: 4, left: 1, right: 3 });
    expect(inRange(range, 3, 2)).toBe(true);
    expect(inRange(range, 5, 2)).toBe(false);
  });
});
describe("copy as SQL", () => {
  it("writes literals for each dialect", () => {
    expect(sqlLiteral(null, "postgres")).toBe("NULL");
    expect(sqlLiteral(12.5, "mysql")).toBe("12.5");
    expect(sqlLiteral("O'Neil \\ path", "postgres")).toBe("'O''Neil \\ path'");
    expect(sqlLiteral("O'Neil \\ path", "mysql")).toBe("'O''Neil \\\\ path'");
    expect(sqlLiteral(true, "sqlite")).toBe("1");
    expect(sqlLiteral({ hex: "0aff" }, "postgres")).toBe("'\\x0aff'::bytea");
    expect(sqlLiteral({ hex: "0aff" }, "mysql")).toBe("X'0aff'");
    expect(sqlLiteral({ k: 1 }, "postgres")).toBe(`'{"k":1}'`);
  });
  it("creates INSERT and UPDATE statements with quoted names", () => {
    const columns = ["id", "full name", "note"];
    const rows = [
      [1, "Ada", null],
      [2, "Bo'b", "x"],
    ];
    expect(insertStatements(table, "postgres", columns, rows)).toBe(
      `INSERT INTO "app"."people" ("id", "full name", "note") VALUES (1, 'Ada', NULL);\n` +
        `INSERT INTO "app"."people" ("id", "full name", "note") VALUES (2, 'Bo''b', 'x');`,
    );
    expect(
      updateStatements(table, "mysql", columns, ["id"], rows.slice(0, 1)),
    ).toBe(
      "UPDATE `app`.`people` SET `full name` = 'Ada', `note` = NULL WHERE `id` = 1;",
    );
    // Without a primary key every column identifies the row; NULL uses IS NULL.
    expect(
      updateStatements(table, "sqlite", columns, [], rows.slice(0, 1)),
    ).toBe(
      `UPDATE "app"."people" SET "id" = 1, "full name" = 'Ada', "note" = NULL WHERE "id" = 1 AND "full name" = 'Ada' AND "note" IS NULL;`,
    );
  });
  it("copies TSV as names, data or both and neutralises formulas", () => {
    const columns = ["a", "b"];
    const rows = [["=1+1", "tab\there"]];
    expect(tsv(columns, rows, "names")).toBe("a\tb");
    expect(tsv(columns, rows, "data")).toBe('\'=1+1\t"tab\there"');
    expect(tsv(columns, rows, "both")).toBe('a\tb\r\n\'=1+1\t"tab\there"');
  });
});
describe("copy and paste round trip", () => {
  it("keeps empty and NULL last rows of a copied block", () => {
    for (const rows of [
      [["x"], [null]],
      [["x"], [""]],
      [[""], [""]],
      [
        ["a", "b"],
        [null, null],
      ],
      [["one"], [null], ["three"]],
    ]) {
      const text = tsv(["c1", "c2"].slice(0, rows[0].length), rows, "data");
      expect(parseClipboardTable(text)).toEqual(
        rows.map((row) => row.map((v) => (v == null ? "" : String(v)))),
      );
    }
    // Spreadsheets add a trailing newline; it still does not create a row.
    expect(parseClipboardTable("x\r\n")).toEqual([["x"]]);
    expect(parseClipboardTable('x\r\n""\r\n')).toEqual([["x"], [""]]);
  });
});
