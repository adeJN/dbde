import { describe, expect, it } from "vitest";
import {
  executable,
  matchesObject,
  newObjectTemplate,
  objectKey,
  objectKinds,
  objectLabel,
  objectSqlName,
  sqliteTriggerTiming,
} from "./db-objects";
import type { DbObject } from "../types";

const fn: DbObject = {
  kind: "function",
  schema: "app",
  name: "total",
  signature: "integer, text",
};
describe("database objects", () => {
  it("offers only the kinds each driver supports", () => {
    expect(objectKinds("postgres")).toEqual([
      "function",
      "procedure",
      "trigger",
      "sequence",
      "materialized_view",
    ]);
    expect(objectKinds("mysql")).toEqual([
      "function",
      "procedure",
      "trigger",
      "event",
    ]);
    expect(objectKinds("sqlite")).toEqual(["trigger"]);
  });
  it("identifies overloads and names objects as SQL", () => {
    expect(objectLabel(fn)).toBe("total(integer, text)");
    expect(objectKey(fn)).not.toBe(objectKey({ ...fn, signature: "integer" }));
    expect(objectSqlName({ ...fn, schema: 'a"b' }, "postgres")).toBe(
      '"a""b"."total"',
    );
    expect(objectSqlName({ ...fn, name: "t`x" }, "mysql")).toBe("`t``x`");
    expect(matchesObject({ ...fn, table: "orders" }, "order")).toBe(true);
    expect(matchesObject(fn, "missing")).toBe(false);
    expect(executable(fn, "postgres")).toBe(true);
    expect(executable({ ...fn, flag: "trigger" }, "postgres")).toBe(false);
    expect(executable(fn, "mysql")).toBe(false);
  });
  it("builds New templates per kind and driver without DELIMITER", () => {
    expect(newObjectTemplate("function", "postgres")).toMatch(
      /^CREATE OR REPLACE FUNCTION "public"\."new_function"/,
    );
    expect(newObjectTemplate("materialized_view", "postgres")).toContain(
      "CREATE UNIQUE INDEX",
    );
    const procedure = newObjectTemplate("procedure", "mysql");
    expect(procedure).toMatch(/^CREATE PROCEDURE `new_procedure`/);
    expect(procedure).not.toMatch(/^DELIMITER/m);
    expect(newObjectTemplate("event", "mysql")).toContain(
      "ON SCHEDULE EVERY 1 DAY",
    );
    expect(newObjectTemplate("trigger", "sqlite")).toContain(
      'AFTER INSERT ON "table_name"',
    );
    expect(() => newObjectTemplate("event", "postgres")).toThrow();
    expect(() => newObjectTemplate("function", "sqlite")).toThrow();
  });
  it("reads SQLite trigger timing like the backend", () => {
    expect(
      sqliteTriggerTiming(
        "CREATE TRIGGER t AFTER UPDATE OF x ON a BEGIN SELECT 1; END",
      ),
    ).toBe("AFTER UPDATE");
    expect(sqliteTriggerTiming("CREATE TRIGGER before_x INSERT ON a")).toBe(
      "BEFORE INSERT",
    );
    expect(
      sqliteTriggerTiming("create trigger v instead of delete on v begin end"),
    ).toBe("INSTEAD OF DELETE");
  });
});
