import { describe, it, expect } from "vitest";
import {
  analyseSql,
  statementAt,
  currentSql,
  checkedSql,
  tableBindings,
  completionQualifier,
} from "./sql-editor";
const table = (name: string, schema = "public") => ({
  name,
  schema,
  kind: "table",
});
describe("SQL editor statement selection", () => {
  it.each(["postgres", "mysql", "sqlite"] as const)(
    "keeps final quoted values and semicolons inside strings for %s",
    (driver) => {
      const text =
        "-- comment;\nSELECT 'a;b' AS name;\nSELECT 'last'; -- tail\n";
      const a = analyseSql(text, driver);
      expect(a.statements.map((s) => s.text)).toEqual([
        "SELECT 'a;b' AS name",
        "SELECT 'last'",
      ]);
      expect(currentSql(text, driver, text.indexOf("last"))).toEqual({
        sql: "SELECT 'last'",
      });
      for (const s of a.statements)
        expect(text.slice(s.start, s.end)).toBe(s.text);
    },
  );
  it("supports PostgreSQL dollar quoting, escaped literals and nested comments", () => {
    const text =
      "/* outer /* nested; */ end */ SELECT $$hello;world$$; SELECT E'a\\\'b;c'; SELECT 3";
    const a = analyseSql(text, "postgres");
    expect(a.issues).toEqual([]);
    expect(a.statements).toHaveLength(3);
    expect(a.statements[0].text).toBe("SELECT $$hello;world$$");
  });
  it("honours MySQL hash comments and the whitespace rule for --", () => {
    const a = analyseSql(
      "# note;\nSELECT 'x\\\'y;z'; SELECT 1--2; SELECT 3",
      "mysql",
    );
    expect(a.statements.map((s) => s.text)).toEqual([
      "SELECT 'x\\\'y;z'",
      "SELECT 1--2",
      "SELECT 3",
    ]);
  });
  it("never falls back to the full script when current statement is empty or unsafe", () => {
    expect(currentSql("-- empty", "sqlite", 0)).toHaveProperty("error");
    const script =
      "CREATE TRIGGER t AFTER INSERT ON x BEGIN UPDATE x SET n=1; END; DELETE FROM y;";
    expect(
      currentSql(script, "sqlite", script.indexOf("UPDATE")),
    ).toHaveProperty("error");
    expect(currentSql(script, "sqlite", 0, "SELECT 1;")).toEqual({
      sql: "SELECT 1;",
    });
  });
  it("reports lexical checks without treating parentheses in text as code", () => {
    expect(analyseSql("SELECT '('; SELECT (1 + 2)", "sqlite").issues).toEqual(
      [],
    );
    for (const text of ["SELECT 'open", "SELECT (1", "SELECT 1)", "/* open"])
      expect(analyseSql(text, "postgres").issues.length).toBeGreaterThan(0);
    expect(analyseSql("(SELECT 1)", "postgres").issues).toEqual([]);
  });
  it("chooses the previous statement at its semicolon and the next inside its text", () => {
    const text = "SELECT 1;\n\nSELECT 2;";
    const a = analyseSql(text, "sqlite");
    expect(statementAt(a, text.indexOf(";"))?.text).toBe("SELECT 1");
    expect(statementAt(a, text.lastIndexOf("2"))?.text).toBe("SELECT 2");
  });
});
describe("SQL metadata bindings", () => {
  const tables = [table("users"), table("orders"), table("other", "private")];
  it("binds qualified tables and aliases, including unaliased JOINs", () => {
    expect(
      tableBindings(
        "SELECT u.id FROM public.users AS u JOIN orders o ON u.id=o.user_id",
        tables,
        "postgres",
      ).map((b) => [b.alias, b.table.name]),
    ).toEqual([
      ["u", "users"],
      ["o", "orders"],
    ]);
    expect(
      tableBindings(
        "SELECT * FROM users JOIN orders ON users.id=orders.id",
        tables,
        "postgres",
      ).map((b) => b.table.name),
    ).toEqual(["users", "orders"]);
    expect(completionQualifier("SELECT u.na", "postgres")).toBe("u");
    expect(completionQualifier('SELECT "My Alias".', "postgres")).toBe(
      "My Alias",
    );
  });
  it("does not guess ambiguous schemas, CTE shadows or aliases reused in different scopes", () => {
    expect(
      tableBindings(
        "SELECT * FROM users u",
        [...tables, table("users", "other")],
        "postgres",
      ),
    ).toEqual([]);
    expect(
      tableBindings(
        "WITH users AS (SELECT 1 AS n) SELECT * FROM users u",
        tables,
        "postgres",
      ),
    ).toEqual([]);
    expect(
      tableBindings(
        "SELECT * FROM users u WHERE EXISTS(SELECT 1 FROM orders u)",
        tables,
        "postgres",
      ),
    ).toEqual([]);
  });
  it("ignores table mentions in comments and string literals", () => {
    const a = analyseSql(
      "SELECT 'FROM orders o' FROM users u -- JOIN other x",
      "postgres",
    );
    expect(
      tableBindings(a.completionCode, tables, "postgres").map(
        (b) => b.table.name,
      ),
    ).toEqual(["users"]);
  });
});

it("does not silently omit executable MySQL comments when choosing a statement", () => {
  expect(
    currentSql("/*!40101 SET SQL_MODE=''; */; SELECT 1", "mysql", 0),
  ).toHaveProperty("error");
});

describe("checked SQL execution", () => {
  const sql = "SELECT 'one;value';\nSELECT 2;\nDELETE FROM orders;";
  it("runs only checked statements, in script order without duplicates", () => {
    expect(checkedSql(sql, "mysql", sql, [1, 0, 1])).toEqual({
      sql: "SELECT 'one;value';\n\nSELECT 2",
    });
  });
  it("refuses selections made before the SQL was edited", () => {
    expect(checkedSql(sql + "SELECT 4;", "mysql", sql, [0])).toHaveProperty(
      "error",
    );
  });
  it("never falls back to running the whole script for empty or invalid selections", () => {
    for (const indexes of [[], [-1], [99], [0.5]])
      expect(checkedSql(sql, "mysql", sql, indexes)).toHaveProperty("error");
  });
  it("supports choosing separate statements on the same line", () => {
    const text = "SELECT 1; SELECT 2;";
    expect(checkedSql(text, "sqlite", text, [1])).toEqual({ sql: "SELECT 2" });
  });
  it("refuses automatic splitting of routines and malformed scripts", () => {
    for (const text of [
      "CREATE PROCEDURE p() BEGIN SELECT 1; END;",
      "SELECT 'unfinished;",
    ])
      expect(checkedSql(text, "mysql", text, [0])).toHaveProperty("error");
  });
});
