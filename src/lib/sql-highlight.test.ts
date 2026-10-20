import { describe, expect, it } from "vitest";
import { highlightSql } from "./sql-highlight";
const kinds = (sql: string, driver: "mysql" | "postgres" | "sqlite") =>
  highlightSql(sql, driver)
    .filter((t) => t.kind !== "text")
    .map((t) => `${t.kind}:${t.text}`);
describe("SQL highlighting", () => {
  it("keeps every character and classifies MySQL DDL", () => {
    const sql =
      "CREATE TABLE `admin` (\n  `idadmin` int(11) NOT NULL AUTO_INCREMENT, -- key\n  note varchar(20) DEFAULT 'it\\'s'\n);";
    expect(
      highlightSql(sql, "mysql")
        .map((t) => t.text)
        .join(""),
    ).toBe(sql);
    expect(kinds(sql, "mysql")).toEqual([
      "keyword:CREATE",
      "keyword:TABLE",
      "identifier:`admin`",
      "identifier:`idadmin`",
      "type:int",
      "number:11",
      "keyword:NOT",
      "keyword:NULL",
      "keyword:AUTO_INCREMENT",
      "comment:-- key",
      "type:varchar",
      "number:20",
      "keyword:DEFAULT",
      "string:'it\\'s'",
    ]);
  });
  it("handles PostgreSQL quoted names, casts and dollar quotes", () => {
    const sql = `CREATE VIEW "Sales" AS SELECT 'a'::text, $f$ DROP $f$ /* c */`;
    expect(
      highlightSql(sql, "postgres")
        .map((t) => t.text)
        .join(""),
    ).toBe(sql);
    expect(kinds(sql, "postgres")).toEqual([
      "keyword:CREATE",
      "keyword:VIEW",
      'identifier:"Sales"',
      "keyword:AS",
      "keyword:SELECT",
      "string:'a'",
      "type:text",
      "string:$f$ DROP $f$",
      "comment:/* c */",
    ]);
  });
  it("does not treat words inside identifiers or strings as keywords", () => {
    expect(kinds(`SELECT "select", 'from' FROM [order]`, "sqlite")).toEqual([
      "keyword:SELECT",
      'identifier:"select"',
      "string:'from'",
      "keyword:FROM",
      "identifier:[order]",
    ]);
  });
});
