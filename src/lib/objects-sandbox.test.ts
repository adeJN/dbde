import { describe, expect, it, vi } from "vitest";
vi.mock("sql.js/dist/sql-wasm.wasm?url", () => ({
  default: "node_modules/sql.js/dist/sql-wasm.wasm",
}));
import { execute, listObjects, objectAction, objectDefinition } from "./api";

describe("sandbox triggers", () => {
  it("lists, defines, replaces and drops triggers in sql.js", async () => {
    await execute(
      "demo",
      'CREATE TABLE audit (msg TEXT); CREATE TRIGGER "orders ""log""" AFTER INSERT ON orders BEGIN INSERT INTO audit VALUES (\'a\'); INSERT INTO audit VALUES (\'b\'); END; CREATE TRIGGER keep BEFORE DELETE ON customers BEGIN SELECT 1; END;',
    );
    const triggers = await listObjects("demo", "workspace", "trigger");
    expect(triggers.map((t) => t.name)).toEqual(["keep", 'orders "log"']);
    const [keep, log] = triggers;
    expect(log).toMatchObject({
      kind: "trigger",
      schema: "",
      table: "orders",
      detail: "AFTER INSERT",
    });
    await expect(listObjects("demo", "workspace", "function")).rejects.toThrow(
      /only triggers/,
    );
    const found = await objectDefinition("demo", "workspace", log);
    expect(found.definition).toMatch(/^CREATE TRIGGER "orders ""log""" AFTER/);
    expect(found.edit_script).toContain(
      'DROP TRIGGER IF EXISTS "orders ""log""";\nCREATE TRIGGER',
    );
    // The edit script, bodies with semicolons included, runs through the executor.
    await execute("demo", found.edit_script, "workspace");
    await execute("demo", "INSERT INTO orders (id) VALUES (99)", "workspace");
    const logged = await execute("demo", "SELECT COUNT(*) FROM audit");
    expect(logged.rows[0][0]).toBe(2);
    expect(
      await objectAction("demo", "workspace", log, "drop", {
        preview: true,
      }),
    ).toBe('DROP TRIGGER "orders ""log"""');
    expect(await listObjects("demo", "workspace", "trigger")).toHaveLength(2);
    await objectAction("demo", "workspace", log, "drop");
    expect(
      (await listObjects("demo", "workspace", "trigger")).map((t) => t.name),
    ).toEqual(["keep"]);
    await expect(objectDefinition("demo", "workspace", log)).rejects.toThrow(
      /no longer exists/,
    );
    await expect(
      objectAction("demo", "workspace", keep, "enable"),
    ).rejects.toThrow(/not available/);
  });
});
