vi.mock("sql.js/dist/sql-wasm.wasm?url", () => ({
  default: "node_modules/sql.js/dist/sql-wasm.wasm",
}));
import { expect, it, vi } from "vitest";
import * as api from "./api";
import { reverseDatabase } from "./database-model";
it("evaluates raw functions on one keyed row and rejects PK/expression injection", async () => {
  await api.execute(
    "demo",
    "CREATE TABLE raw_mode_test (id INTEGER PRIMARY KEY, at TEXT); INSERT INTO raw_mode_test VALUES (1,'old'),(2,'keep');",
  );
  const table = { name: "raw_mode_test", schema: "main", kind: "table" };
  const result = await api.viewTable("demo", "workspace", table, 1, 1000);
  expect(
    await api.updateRawCell(
      "demo",
      result.source!,
      { id: 1 },
      "at",
      "CURRENT_TIMESTAMP",
    ),
  ).toBe(1);
  const after = await api.execute(
    "demo",
    "SELECT at FROM raw_mode_test ORDER BY id",
  );
  expect(String(after.rows[0][0])).toMatch(/^\d{4}-\d{2}-\d{2}/);
  expect(after.rows[1][0]).toBe("keep");
  await expect(
    api.updateRawCell("demo", result.source!, { id: 1 }, "id", "RANDOM()"),
  ).rejects.toThrow();
  await expect(
    api.updateRawCell(
      "demo",
      result.source!,
      { id: 1 },
      "at",
      "CURRENT_TIMESTAMP;DELETE FROM raw_mode_test",
    ),
  ).rejects.toThrow();
  await expect(
    api.updateRawCell("demo", result.source!, {}, "at", "CURRENT_TIMESTAMP"),
  ).rejects.toThrow();
});
it("reverse engineers primary keys and foreign key relationships from SQLite", async () => {
  await api.execute(
    "demo",
    "CREATE TABLE er_child (id INTEGER PRIMARY KEY, parent INTEGER REFERENCES customers(id))",
  );
  const recordRead = vi
    .spyOn(api, "viewTable")
    .mockRejectedValue(new Error("ER modeling must not read records"));
  const model = await reverseDatabase(
    { id: "demo", config: api.demoConfig },
    "workspace",
  );
  const parent = model.tables.find((t) => t.table.name === "customers")!;
  const child = model.tables.find((t) => t.table.name === "er_child")!;
  expect(parent.indexes.find((i) => i.primary)?.columns).toEqual(["id"]);
  expect(child.keys[0].referenced_table.name).toBe("customers");
  expect(recordRead).not.toHaveBeenCalled();
  recordRead.mockRestore();
});
