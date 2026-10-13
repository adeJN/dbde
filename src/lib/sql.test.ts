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
