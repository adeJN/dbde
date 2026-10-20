import { describe, expect, it, vi } from "vitest";
vi.mock("sql.js/dist/sql-wasm.wasm?url", () => ({
  default: "node_modules/sql.js/dist/sql-wasm.wasm",
}));
import { columns, execute, foreignKeys } from "./api";

const table = (name: string) => ({ name, schema: "", kind: "table" });
describe("sandbox foreign keys", () => {
  it("lists column pairs from pragma_foreign_key_list, composite and implicit", async () => {
    // Nothing is listed (and the engine is not started) before a table was read.
    expect(await foreignKeys("demo", table("orders"))).toEqual([]);
    await execute(
      "demo",
      'CREATE TABLE account (tenant INTEGER, code TEXT, PRIMARY KEY (tenant, code)); CREATE TABLE "line ""x""" (id INTEGER PRIMARY KEY, customer INTEGER REFERENCES customers, c TEXT, t INTEGER, flag BOOLEAN, FOREIGN KEY (c, t) REFERENCES account (code, tenant))',
    );
    const keys = await foreignKeys("demo", table('line "x"'));
    expect(keys).toEqual(
      expect.arrayContaining([
        {
          name: expect.any(String),
          columns: ["customer"],
          referenced_table: { name: "customers", schema: "", kind: "table" },
          referenced_columns: ["id"],
        },
        {
          name: expect.any(String),
          columns: ["c", "t"],
          referenced_table: { name: "account", schema: "", kind: "table" },
          referenced_columns: ["code", "tenant"],
        },
      ]),
    );
    expect(await foreignKeys("demo", table("customers"))).toEqual([]);
    const info = await columns("demo", table('line "x"'));
    expect(info.find((c) => c.name === "flag")?.is_boolean).toBe(true);
    expect(info.find((c) => c.name === "t")?.is_boolean).toBeUndefined();
  });
});
