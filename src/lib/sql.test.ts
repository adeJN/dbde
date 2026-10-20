import { describe, expect, it } from "vitest";
import { csvCell, quoteIdentifier, tableQuery } from "./sql";
import { useWorkspace } from "../store";
describe("SQL identifiers and exports", () => {
  it("escapes identifiers without interpreting injected SQL", () => {
    expect(quoteIdentifier('a"; DROP TABLE users;--', "postgres")).toBe(
      '"a""; DROP TABLE users;--"',
    );
    expect(quoteIdentifier("a`b", "mysql")).toBe("`a``b`");
    expect(
      tableQuery(
        { name: "order", schema: "public", kind: "table" },
        "postgres",
      ),
    ).toBe('SELECT * FROM "public"."order"\nLIMIT 1000;');
  });
  it("previews table sort with primary-key tie breaking", () => {
    expect(
      tableQuery(
        { name: "people", schema: "", kind: "table" },
        "sqlite",
        25,
        2,
        ["id"],
        [],
        { column: "name", direction: "desc" },
      ),
    ).toContain('ORDER BY "name" DESC, "id"\nLIMIT 25 OFFSET 25;');
  });
  it("preserves CSV quotes, multiline values, and blocks spreadsheet formula execution", () => {
    expect(csvCell('hello,"world"\n')).toBe('"hello,""world""\n"');
    expect(csvCell('=HYPERLINK("bad")')).toBe('"\'=HYPERLINK(""bad"")"');
    expect(csvCell(null)).toBe('""');
    for (const value of [-12.5, "-12.50", "+6281234", "-1e5"])
      expect(csvCell(value)).toBe(`"${value}"`);
    expect(csvCell("-1+1|cmd")).toBe('"\'-1+1|cmd"');
    expect(csvCell("+62 812")).toBe('"\'+62 812"');
  });
});
describe("workspace lifetime", () => {
  it("keeps database context independent for tabs on the same server", () => {
    const w = useWorkspace.getState();
    w.addTab("server", "SELECT 1", "Analytics", "analytics");
    const first = useWorkspace.getState().activeTab;
    w.addTab("server", "SELECT 2", "Application", "app_db");
    const second = useWorkspace.getState().activeTab;
    w.updateTab(first, { database: "reporting" });
    expect(
      useWorkspace.getState().tabs.find((t) => t.id === first)?.database,
    ).toBe("reporting");
    expect(
      useWorkspace.getState().tabs.find((t) => t.id === second)?.database,
    ).toBe("app_db");
    w.removeSession("server");
  });
  it("releases results and tabs when their connection is removed", () => {
    const w = useWorkspace.getState();
    w.addTab("first", "SELECT 1", "first");
    const firstId = useWorkspace.getState().activeTab;
    w.updateTab(firstId, {
      result: {
        columns: ["x"],
        rows: [[1]],
        affected_rows: 0,
        execution_ms: 1,
        truncated: false,
      },
    });
    w.addTab("second", "SELECT 2", "second");
    w.removeSession("first");
    expect(
      useWorkspace.getState().tabs.some((t) => t.connectionId === "first"),
    ).toBe(false);
    expect(
      useWorkspace
        .getState()
        .tabs.find((t) => t.id === useWorkspace.getState().activeTab)
        ?.connectionId,
    ).toBe("second");
    w.removeSession("second");
    expect(useWorkspace.getState().tabs).toHaveLength(0);
    expect(useWorkspace.getState().activeTab).toBe("");
    // An in-flight response from a closed connection must not recreate its tab.
    w.updateTab(firstId, { query: "late response" });
    expect(useWorkspace.getState().tabs).toHaveLength(0);
  });
});
describe("destructive SQL detection", () => {
  it("flags unfiltered writes and drops but not filtered or quoted ones", async () => {
    const { destructiveStatements } = await import("./sql");
    expect(
      destructiveStatements(
        "DELETE FROM a; DELETE FROM b WHERE id = 1; update c set x = 1;\nDROP TABLE d; TRUNCATE e; ALTER TABLE f DROP COLUMN g; ALTER TABLE h ADD COLUMN i int",
        "postgres",
      ),
    ).toEqual([
      "DELETE FROM a",
      "update c set x = 1",
      "DROP TABLE d",
      "TRUNCATE e",
      "ALTER TABLE f DROP COLUMN g",
    ]);
    // Keywords and semicolons inside strings, identifiers and comments do not count.
    expect(
      destructiveStatements(
        "SELECT 'x; DROP TABLE y'; -- DELETE FROM z\nUPDATE t SET note = 'no where here' WHERE id = 2; /* TRUNCATE q; */ SELECT \"; drop\" FROM w",
        "postgres",
      ),
    ).toEqual([]);
    expect(
      destructiveStatements("SELECT $$; DROP TABLE x;$$", "postgres"),
    ).toEqual([]);
    expect(
      destructiveStatements(
        "SELECT 'it\\'s; DROP TABLE x'; # DELETE FROM y\nSELECT 1",
        "mysql",
      ),
    ).toEqual([]);
  });
  it("builds table actions with quoted names and the SQLite truncate form", async () => {
    const { tableActionSql, completionIdentifier } = await import("./sql");
    const table = { name: 'Odd"Name', schema: "app", kind: "table" };
    expect(tableActionSql("drop", table, "postgres")).toBe(
      'DROP TABLE "app"."Odd""Name";',
    );
    expect(tableActionSql("truncate", table, "mysql")).toBe(
      'TRUNCATE TABLE `app`.`Odd"Name`;',
    );
    expect(tableActionSql("truncate", { ...table, schema: "" }, "sqlite")).toBe(
      'DELETE FROM "Odd""Name";',
    );
    expect(
      tableActionSql("drop", { ...table, kind: "view" }, "postgres"),
    ).toMatch(/^DROP VIEW /);
    expect(completionIdentifier("orders", "postgres")).toBe("orders");
    expect(completionIdentifier("Orders", "postgres")).toBe('"Orders"');
    expect(completionIdentifier("Orders", "mysql")).toBe("Orders");
    expect(completionIdentifier("order items", "mysql")).toBe("`order items`");
  });
});
it("detects destructive CTE writes and ignores WHERE clauses in nested queries", async () => {
  const { destructiveStatements } = await import("./sql");
  for (const query of [
    "WITH c AS (SELECT 1 WHERE true) DELETE FROM users;",
    "WITH c AS (SELECT 1) UPDATE users SET name = 'x';",
    "WITH c AS (DELETE FROM users RETURNING id) SELECT * FROM c;",
    "UPDATE users SET name = (SELECT name FROM source WHERE id = 1);",
  ])
    expect(destructiveStatements(query, "postgres")).toHaveLength(1);
  expect(
    destructiveStatements(
      "WITH c AS (SELECT 1) DELETE FROM users WHERE id IN (SELECT * FROM c)",
      "postgres",
    ),
  ).toEqual([]);
});
describe("renaming tables", () => {
  it("validates new names per database and catches clashes", async () => {
    const { tableNameError } = await import("./sql");
    const table = { name: "users", schema: "app", kind: "table" };
    const existing = [table, { name: "Orders", schema: "app", kind: "table" }];
    expect(tableNameError(table, "", "mysql")).toMatch(/Enter a name/);
    expect(tableNameError(table, " users2", "mysql")).toMatch(/spaces/);
    expect(tableNameError(table, "users", "mysql")).toMatch(/different/);
    expect(tableNameError(table, "x".repeat(65), "mysql")).toMatch(/64/);
    expect(tableNameError(table, "é".repeat(32), "postgres")).toMatch(
      /63 bytes/,
    );
    expect(tableNameError(table, "orders", "mysql", existing)).toMatch(
      /exists/,
    );
    // PostgreSQL names are case-sensitive once quoted.
    expect(tableNameError(table, "orders", "postgres", existing)).toBe("");
    expect(tableNameError({ ...table, kind: "view" }, "v2", "sqlite")).toMatch(
      /cannot rename a view/,
    );
    expect(tableNameError(table, "members", "sqlite", existing)).toBe("");
  });
  it("previews the statement the backend runs", async () => {
    const { renameTableSql } = await import("./sql");
    const table = { name: "old`name", schema: "app", kind: "table" };
    expect(renameTableSql(table, "new", "mysql")).toBe(
      "RENAME TABLE `app`.`old``name` TO `app`.`new`;",
    );
    expect(renameTableSql({ ...table, kind: "view" }, 'N"ew', "postgres")).toBe(
      'ALTER VIEW "app"."old`name" RENAME TO "N""ew";',
    );
    expect(renameTableSql({ ...table, schema: "" }, "new", "sqlite")).toBe(
      'ALTER TABLE "old`name" RENAME TO "new";',
    );
  });
});
