import { describe, expect, it, vi } from "vitest";
vi.mock("sql.js/dist/sql-wasm.wasm?url", () => ({
  default: "node_modules/sql.js/dist/sql-wasm.wasm",
}));
import {
  columns,
  execute,
  schema,
  viewTable,
  deleteRows,
  insertRecord,
  updateCell,
} from "./api";
describe("real SQLite browser sandbox", () => {
  it("sorts all pages and writes only validated record columns", async () => {
    await execute(
      "demo",
      "CREATE TABLE record_test (id INTEGER PRIMARY KEY, name TEXT, note TEXT)",
    );
    await execute(
      "demo",
      "INSERT INTO record_test (name) VALUES ('Zed'), ('Amy'), ('Bob')",
    );
    const table = { name: "record_test", schema: "", kind: "table" };
    const sort = { column: "name", direction: "desc" as const };
    const page = await viewTable("demo", "workspace", table, 2, 1, [], sort);
    expect(page.rows[0][1]).toBe("Bob");
    expect(page.source?.sort).toEqual(sort);
    await expect(
      viewTable("demo", "workspace", table, 1, 1, [], {
        column: "bad",
        direction: "asc",
      }),
    ).rejects.toThrow("Unknown sort");
    expect(
      await updateCell(
        "demo",
        page.source!,
        { id: page.rows[0][0] },
        "note",
        "reviewed",
      ),
    ).toBe(1);
    await expect(
      updateCell("demo", page.source!, { id: page.rows[0][0] }, "id", "99"),
    ).rejects.toThrow("cannot be edited");
    expect(
      await insertRecord("demo", page.source!, { name: "New", note: null }),
    ).toBe(1);
    await expect(
      insertRecord("demo", page.source!, { bad: "x" }),
    ).rejects.toThrow("Unknown insert column");
    const refreshed = await viewTable("demo", "workspace", table);
    expect(refreshed.pagination?.total_rows).toBe(4);
    expect(refreshed.rows.find((row) => row[1] === "Bob")?.[2]).toBe(
      "reviewed",
    );
    expect(refreshed.rows.find((row) => row[1] === "New")?.[2]).toBeNull();
    await execute("demo", "DROP TABLE record_test");
  });
  it("filters the whole table before pagination, handles NULLs and treats wildcards literally", async () => {
    await execute(
      "demo",
      "CREATE TABLE filter_test (id INTEGER PRIMARY KEY, name TEXT, status TEXT)",
    );
    await execute(
      "demo",
      "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 1205) INSERT INTO filter_test SELECT n, 'row ' || n, CASE WHEN n > 1000 THEN 'target' ELSE 'other' END FROM seq",
    );
    const table = { name: "filter_test", schema: "", kind: "table" };
    const filters = [
      { column: "status", operator: "equals" as const, value: "target" },
    ];
    const page = await viewTable("demo", "workspace", table, 2, 100, filters);
    expect(page.pagination).toEqual({
      page: 2,
      page_size: 100,
      total_rows: 205,
    });
    expect(page.rows[0][0]).toBe(1101);
    expect(page.source?.filters).toEqual(filters);
    await execute(
      "demo",
      "INSERT INTO filter_test VALUES (1300, '100%_done!', NULL)",
    );
    const literal = await viewTable("demo", "workspace", table, 1, 1000, [
      { column: "name", operator: "contains", value: "%_" },
    ]);
    expect(literal.rows).toHaveLength(1);
    expect(literal.rows[0][0]).toBe(1300);
    const nulls = await viewTable("demo", "workspace", table, 1, 1000, [
      { column: "status", operator: "is_null", value: "" },
    ]);
    expect(nulls.rows).toHaveLength(1);
    const injection = await viewTable("demo", "workspace", table, 1, 1000, [
      { column: "status", operator: "equals", value: "target' OR 1=1 --" },
    ]);
    expect(injection.rows).toHaveLength(0);
    await expect(
      viewTable("demo", "workspace", table, 1, 1000, [
        { column: "bad_column", operator: "equals", value: "x" },
      ]),
    ).rejects.toThrow("Unknown filter");
    await execute("demo", "DROP TABLE filter_test");
  });
  it("fetches pages beyond 1,000 rows and clamps pages after deletion", async () => {
    await execute(
      "demo",
      "CREATE TABLE pagination_test (id INTEGER PRIMARY KEY)",
    );
    await execute(
      "demo",
      "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 1505) INSERT INTO pagination_test SELECT n FROM seq",
    );
    const table = { name: "pagination_test", schema: "", kind: "table" };
    const first = await viewTable("demo", "workspace", table);
    expect(first.rows).toHaveLength(1000);
    expect(first.pagination).toEqual({
      page: 1,
      page_size: 1000,
      total_rows: 1505,
    });
    const next = await viewTable("demo", "workspace", table, 2, 1000);
    expect(next.rows).toHaveLength(505);
    expect(next.rows[0]).toEqual([1001]);
    expect(next.rows.at(-1)).toEqual([1505]);
    const resized = await viewTable("demo", "workspace", table, 99, 500);
    expect(resized.pagination?.page).toBe(4);
    expect(resized.rows).toHaveLength(5);
    await deleteRows(
      "demo",
      resized.source!,
      resized.rows.map((row) => ({ id: row[0] })),
    );
    const clamped = await viewTable("demo", "workspace", table, 4, 500);
    expect(clamped.pagination?.page).toBe(3);
    expect(clamped.rows[0]).toEqual([1001]);
    await expect(
      viewTable("demo", "workspace", table, 1, 5001),
    ).rejects.toThrow("Invalid page");
    await execute("demo", "DROP TABLE pagination_test");
  });
  it("deletes selected composite keys atomically in table views", async () => {
    await execute(
      "demo",
      "CREATE TABLE row_actions (tenant TEXT, id INTEGER, name TEXT, PRIMARY KEY (tenant, id))",
    );
    await execute(
      "demo",
      "INSERT INTO row_actions VALUES ('a', 1, 'one'), ('b', 1, 'two'), ('a', 2, 'three')",
    );
    const table = { name: "row_actions", schema: "", kind: "table" };
    const view = await viewTable("demo", "workspace", table);
    const source = view.source!;
    expect(source.primary_keys).toEqual(["tenant", "id"]);
    await expect(
      deleteRows("demo", source, [
        { tenant: "a", id: 1 },
        { tenant: "missing", id: 4 },
      ]),
    ).rejects.toThrow("stale");
    expect((await viewTable("demo", "workspace", table)).rows).toHaveLength(3);
    await expect(deleteRows("demo", source, [{ id: 1 }])).rejects.toThrow(
      "complete primary key",
    );
    expect(await deleteRows("demo", source, [{ tenant: "a", id: 1 }])).toBe(1);
    expect(
      (
        await execute(
          "demo",
          "SELECT tenant, id FROM row_actions ORDER BY tenant, id",
        )
      ).rows,
    ).toEqual([
      ["a", 2],
      ["b", 1],
    ]);
    await execute("demo", "DROP TABLE row_actions");
  });
  it("loads schema and lazy column metadata from SQLite", async () => {
    const tree = await schema("demo");
    expect(tree.tables.map((t) => t.name)).toEqual([
      "customers",
      "orders",
      "products",
    ]);
    const fields = await columns("demo", tree.tables[0]);
    expect(fields.find((c) => c.name === "name")).toEqual({
      name: "name",
      data_type: "TEXT",
      nullable: false,
    });
  });
  it("executes joins, writes, and errors against the database rather than canned responses", async () => {
    const joined = await execute(
      "demo",
      "SELECT c.name, o.total FROM customers c JOIN orders o ON c.id = o.customer_id ORDER BY o.id",
    );
    expect(joined.rows).toEqual([
      ["Olivia Rhye", 149],
      ["Phoenix Baker", 79],
    ]);
    await execute("demo", "CREATE TABLE check_writes (id INTEGER, label TEXT)");
    const inserted = await execute(
      "demo",
      "INSERT INTO check_writes VALUES (9, 'persisted for this session')",
    );
    expect(inserted.affected_rows).toBe(1);
    expect((await execute("demo", "SELECT * FROM check_writes")).rows).toEqual([
      [9, "persisted for this session"],
    ]);
    await expect(
      execute("demo", "SELECT * FROM missing_table"),
    ).rejects.toThrow("no such table");
  });
  it("preserves headers for empty results and bounds large results", async () => {
    const empty = await execute(
      "demo",
      "SELECT id, name FROM customers WHERE id < 0",
    );
    expect(empty.columns).toEqual(["id", "name"]);
    expect(empty.rows).toEqual([]);
    expect(empty.affected_rows).toBe(0);
    const large = await execute(
      "demo",
      "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 50001) SELECT n FROM seq",
    );
    expect(large.rows).toHaveLength(50000);
    expect(large.truncated).toBe(true);
  });
});
