import { describe, expect, it } from "vitest";
import {
  forwardModel,
  parseModel,
  syncModel,
  type DatabaseModel,
} from "./database-model";
const model: DatabaseModel = {
  version: 1,
  driver: "postgres",
  database: "shop",
  tables: [
    {
      table: { name: "items", schema: "public", kind: "table" },
      columns: [
        { name: "id", data_type: "integer", nullable: false },
        { name: "name", data_type: "varchar(100)", nullable: true },
      ],
      indexes: [
        { name: "items_pkey", columns: ["id"], primary: true, unique: true },
      ],
      keys: [],
      x: 24,
      y: 24,
    },
  ],
};
describe("database models", () => {
  it("generates a forward model with quoted names, PKs and fields", () => {
    const sql = forwardModel(model);
    expect(sql).toContain('CREATE TABLE "public"."items"');
    expect(sql).toContain('"name" varchar(100)');
    expect(sql).toContain('PRIMARY KEY ("id")');
    expect(parseModel(JSON.stringify(model))).toEqual(model);
  });
  it("rejects invalid imported shapes and unsafe type fragments", () => {
    expect(() => parseModel('{"version":2}')).toThrow();
    const broken = structuredClone(model);
    broken.tables[0].columns[0].data_type = "integer); DROP TABLE users;";
    expect(() => forwardModel(broken)).toThrow("Type");
  });
  it("syncs additions and reports nonadditive changes without dropping data", () => {
    const live = structuredClone(model);
    live.tables[0].columns = live.tables[0].columns.slice(0, 1);
    const plan = syncModel(model, live);
    expect(plan.sql).toContain('ADD COLUMN "name" varchar(100)');
    expect(plan.sql).not.toContain("DROP");
    const changed = structuredClone(model);
    changed.tables[0].columns[0].nullable = true;
    expect(syncModel(changed, model).notes[0]).toContain("nullability");
    expect(syncModel(changed, model).sql).toBe("");
  });
});

it("rejects malformed relationships before a model can enter the renderer", () => {
  const malformed = structuredClone(model);
  malformed.tables[0].keys = [null as never];
  expect(() => parseModel(JSON.stringify(malformed))).toThrow("relationship");
});
