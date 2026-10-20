import { describe, expect, it, vi } from "vitest";
import { loadTableDetails } from "./table-structure";
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
  listIndexes,
  tableDdl,
  insertRecords,
  renameTableFields,
} from "./api";
describe("real SQLite browser sandbox", () => {
  it("renames a field without losing its records or default and rejects conflicting names", async () => {
    await execute(
      "demo",
      "CREATE TABLE rename_test (id INTEGER PRIMARY KEY, name TEXT NOT NULL DEFAULT 'Guest'); CREATE INDEX rename_name ON rename_test(name); INSERT INTO rename_test VALUES (1,'Ada');",
    );
    const table = { name: "rename_test", schema: "", kind: "table" };
    try {
      await renameTableFields("demo", "workspace", table, [
        { from: "name", to: "full name" },
      ]);
      expect(
        (await execute("demo", 'SELECT "full name" FROM rename_test')).rows,
      ).toEqual([["Ada"]]);
      expect(await tableDdl("demo", table)).toContain(
        '"full name" TEXT NOT NULL DEFAULT',
      );
      await expect(
        renameTableFields("demo", "workspace", table, [
          { from: "full name", to: "ID" },
        ]),
      ).rejects.toThrow("already exists");
      expect((await columns("demo", table)).map((field) => field.name)).toEqual(
        ["id", "full name"],
      );
    } finally {
      await execute("demo", "DROP TABLE rename_test;");
    }
  });
  it("loads designer metadata for generated fields, defaults, composite relationships and triggers", async () => {
    await execute(
      "demo",
      "CREATE TABLE structure_parent (a INTEGER, b INTEGER, PRIMARY KEY (a,b)); CREATE TABLE structure_child (id INTEGER PRIMARY KEY, a INTEGER, b INTEGER, name TEXT DEFAULT 'Guest', label TEXT GENERATED ALWAYS AS (upper(name)) VIRTUAL, FOREIGN KEY(a,b) REFERENCES structure_parent(a,b), CHECK(length(name)>0)); CREATE TRIGGER structure_changed AFTER UPDATE ON structure_child BEGIN SELECT 1; END;",
    );
    try {
      const details = await loadTableDetails(
        "demo",
        "workspace",
        { name: "structure_child", schema: "", kind: "table" },
        "sqlite",
      );
      expect(details.fields.find((field) => field.name === "id")?.primary).toBe(
        true,
      );
      expect(
        details.fields.find((field) => field.name === "label")?.generated,
      ).toBe(true);
      expect(
        details.fields.find((field) => field.name === "name")?.default_value,
      ).toBe("'Guest'");
      expect(details.foreignKeys).toHaveLength(1);
      expect(details.foreignKeys[0].definition).toContain(
        "(a, b) → structure_parent (a, b)",
      );
      expect(details.triggers[0].name).toBe("structure_changed");
      expect(details.unavailable).toContain("Checks");
    } finally {
      await execute(
        "demo",
        "DROP TABLE structure_child; DROP TABLE structure_parent;",
      );
    }
  });
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
    ).resolves.toBe(1);
    expect(
      await insertRecord("demo", page.source!, { name: "New", note: null }),
    ).toBe(1);
    await expect(
      insertRecord("demo", page.source!, { bad: "x" }),
    ).rejects.toThrow(/unknown column/i);
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
describe("sandbox schema metadata", () => {
  it("lists indexes and exports CREATE statements", async () => {
    await execute(
      "demo",
      "CREATE TABLE idx_test (id INTEGER PRIMARY KEY, email TEXT UNIQUE, name TEXT); CREATE INDEX idx_test_name ON idx_test (name, email)",
    );
    const table = { name: "idx_test", schema: "", kind: "table" };
    const indexes = await listIndexes("demo", table);
    expect(indexes.find((i) => i.name === "idx_test_name")).toEqual({
      name: "idx_test_name",
      columns: ["name", "email"],
      unique: false,
      primary: false,
    });
    expect(indexes.some((i) => i.unique && i.columns[0] === "email")).toBe(
      true,
    );
    const ddl = await tableDdl("demo", table);
    expect(ddl).toMatch(/^CREATE TABLE idx_test/);
    expect(ddl).toContain(
      "CREATE INDEX idx_test_name ON idx_test (name, email);",
    );
    await execute("demo", "DROP TABLE idx_test");
  });
});
describe("sandbox batch inserts", () => {
  it("saves every record or none", async () => {
    await execute(
      "demo",
      "CREATE TABLE batch_test (id INTEGER PRIMARY KEY, email TEXT UNIQUE NOT NULL, note TEXT DEFAULT 'none')",
    );
    const source = {
      database: "workspace",
      table: { name: "batch_test", schema: "", kind: "table" },
      primary_keys: ["id"],
    };
    expect(
      await insertRecords("demo", source, [
        { email: "a@x" },
        { email: "b@x", note: null },
      ]),
    ).toBe(2);
    await expect(
      insertRecords("demo", source, [{ email: "c@x" }, { email: "a@x" }]),
    ).rejects.toThrow(/Record 2 of 2.*No records were saved/);
    expect(
      (await execute("demo", "SELECT email, note FROM batch_test ORDER BY id"))
        .rows,
    ).toEqual([
      ["a@x", "none"],
      ["b@x", null],
    ]);
    await execute("demo", "DROP TABLE batch_test");
  });
});

it("blocks invalid typed values before any sandbox batch writes", async () => {
  const { applyChanges } = await import("./api");
  await execute(
    "demo",
    "CREATE TABLE typed_values (id INTEGER PRIMARY KEY, qty INTEGER NOT NULL, code VARCHAR(3), payload JSON)",
  );
  const source = {
    database: "workspace",
    table: { name: "typed_values", schema: "", kind: "table" },
    primary_keys: ["id"],
  };
  await expect(
    applyChanges("demo", source, [
      { kind: "insert", values: { qty: "2" } },
      { kind: "insert", values: { qty: "no" } },
    ]),
  ).rejects.toThrow("Record 2: qty");
  expect(
    (await execute("demo", "SELECT * FROM typed_values")).rows,
  ).toHaveLength(0);
  await expect(
    insertRecords("demo", source, [{ qty: "1", code: "long" }]),
  ).rejects.toThrow("Maximum 3");
  await insertRecord("demo", source, {
    qty: "3",
    code: "abc",
    payload: '{"ok":true}',
  });
  await expect(
    updateCell("demo", source, { id: 1 }, "qty", null),
  ).rejects.toThrow("NULL is not allowed");
  expect((await execute("demo", "SELECT qty FROM typed_values")).rows).toEqual([
    [3],
  ]);
});

it("updates composite keys atomically and preserves data on uniqueness or FK conflicts", async () => {
  const { applyChanges } = await import("./api");
  await execute(
    "demo",
    "PRAGMA foreign_keys=ON; CREATE TABLE pk_parent (tenant TEXT NOT NULL, id INTEGER NOT NULL, name TEXT, PRIMARY KEY(tenant,id)); INSERT INTO pk_parent VALUES('a',1,'first'),('b',2,'second'); CREATE TABLE pk_child (tenant TEXT, parent_id INTEGER, FOREIGN KEY(tenant,parent_id) REFERENCES pk_parent(tenant,id) ON UPDATE CASCADE); INSERT INTO pk_child VALUES('a',1);",
  );
  const source = (
    await viewTable("demo", "workspace", {
      name: "pk_parent",
      schema: "",
      kind: "table",
    })
  ).source!;
  await applyChanges("demo", source, [
    {
      kind: "update",
      key: { tenant: "a", id: 1 },
      values: { tenant: "new", id: "7", name: "edited" },
    },
  ]);
  expect(
    (await execute("demo", "SELECT tenant,parent_id FROM pk_child")).rows,
  ).toEqual([["new", 7]]);
  await expect(
    applyChanges("demo", source, [
      {
        kind: "update",
        key: { tenant: "new", id: 7 },
        values: { name: "rollback" },
      },
      {
        kind: "update",
        key: { tenant: "b", id: 2 },
        values: { tenant: "new", id: "7" },
      },
    ]),
  ).rejects.toThrow();
  expect(
    (await execute("demo", "SELECT name FROM pk_parent WHERE tenant='new'"))
      .rows,
  ).toEqual([["edited"]]);
  await expect(
    applyChanges("demo", source, [
      { kind: "update", key: { tenant: "new", id: 7 }, values: { id: null } },
    ]),
  ).rejects.toThrow(/cannot be NULL/);
  await expect(
    applyChanges("demo", source, [
      { kind: "update", key: { tenant: "new", id: 7 }, values: { id: "8" } },
      { kind: "delete", key: { tenant: "new", id: 7 } },
    ]),
  ).rejects.toThrow(/same record/);
  await execute(
    "demo",
    "CREATE TABLE pk_restrict (tenant TEXT,parent_id INTEGER,FOREIGN KEY(tenant,parent_id) REFERENCES pk_parent(tenant,id) ON UPDATE RESTRICT); INSERT INTO pk_restrict VALUES('new',7);",
  );
  await expect(
    updateCell("demo", source, { tenant: "new", id: 7 }, "id", "8"),
  ).rejects.toThrow();
  expect(
    (await execute("demo", "SELECT tenant,parent_id FROM pk_child")).rows,
  ).toEqual([["new", 7]]);
  await execute("demo", "DELETE FROM pk_restrict; DELETE FROM pk_child;");
  await updateCell("demo", source, { tenant: "new", id: 7 }, "id", "9");
  await deleteRows("demo", source, [{ tenant: "new", id: 9 }]);
  expect(
    (await execute("demo", "SELECT tenant,id FROM pk_parent")).rows,
  ).toEqual([["b", 2]]);
});
