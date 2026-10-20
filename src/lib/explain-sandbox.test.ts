import { expect, it, vi } from "vitest";
vi.mock("sql.js/dist/sql-wasm.wasm?url", () => ({
  default: "node_modules/sql.js/dist/sql-wasm.wasm",
}));
import { execute, explain, maintainTables } from "./api";
import { parsePlan } from "./explain";

it("explains sandbox SQL with EXPLAIN QUERY PLAN without running it", async () => {
  const output = await explain(
    "demo",
    "DELETE FROM customers WHERE email LIKE '%x';",
    "workspace",
    undefined,
    false,
    false,
  );
  expect(output.sql).toBe(
    "EXPLAIN QUERY PLAN DELETE FROM customers WHERE email LIKE '%x'",
  );
  expect(output.columns).toEqual(["id", "parent", "notused", "detail"]);
  const plan = parsePlan(output, "sqlite");
  expect(plan.warnings).toEqual(["Full table scan on customers"]);
  expect(
    (await execute("demo", "SELECT COUNT(*) FROM customers")).rows,
  ).toEqual([[240]]);
  await expect(
    explain(
      "demo",
      "SELECT 1; DELETE FROM orders",
      "workspace",
      undefined,
      false,
      false,
    ),
  ).rejects.toThrow(/one statement/);
  await expect(
    explain("demo", "SELECT 1", "workspace", undefined, true, false),
  ).rejects.toThrow(/ANALYZE/);
});

it("runs SQLite maintenance in the sandbox and reports each table", async () => {
  const tables = ["customers", "orders"].map((name) => ({
    name,
    schema: "",
    kind: "table",
  }));
  const check = await maintainTables(
    "demo",
    "workspace",
    tables,
    "integrity-check",
  );
  expect(check.statements).toEqual([
    'PRAGMA integrity_check("customers")',
    'PRAGMA integrity_check("orders")',
  ]);
  expect(check.rows).toEqual([
    {
      table: "customers",
      op: "integrity check",
      msg_type: "status",
      msg_text: "OK",
    },
    {
      table: "orders",
      op: "integrity check",
      msg_type: "status",
      msg_text: "OK",
    },
  ]);
  const vacuum = await maintainTables("demo", "workspace", [], "vacuum");
  expect(vacuum.rows).toEqual([
    {
      table: "workspace",
      op: "vacuum database",
      msg_type: "status",
      msg_text: "OK",
    },
  ]);
  const missing = await maintainTables(
    "demo",
    "workspace",
    [{ name: "missing", schema: "", kind: "table" }],
    "reindex",
  );
  expect(missing.rows[0].msg_type).toBe("error");
  await expect(
    maintainTables("demo", "workspace", tables, "optimize"),
  ).rejects.toThrow();
});
