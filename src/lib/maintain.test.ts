import { expect, it } from "vitest";
import {
  maintainInfo,
  maintainOperations,
  maintainSql,
  maintainText,
  repairableEngine,
} from "./maintain";

const table = (name: string, schema = "") => ({ name, schema, kind: "table" });

it("offers per-driver operations and marks the locking ones", () => {
  expect(maintainOperations("mysql").map((op) => op.operation)).toEqual([
    "analyze",
    "check",
    "optimize",
    "repair",
  ]);
  expect(
    maintainOperations("postgres")
      .filter((op) => op.locking)
      .map((op) => op.operation),
  ).toEqual(["vacuum-full", "reindex"]);
  expect(maintainInfo("vacuum", "sqlite")).toMatchObject({
    databaseWide: true,
    locking: true,
  });
  expect(maintainInfo("repair", "postgres")).toBeUndefined();
});

it("builds quoted statements that match the backend", () => {
  expect(
    maintainSql("optimize", "mysql", [
      table("a`b", "shop"),
      table("c", "shop"),
    ]),
  ).toEqual(["OPTIMIZE TABLE `shop`.`a``b`, `shop`.`c`"]);
  expect(
    maintainSql("vacuum-full", "postgres", [table('Order"s', "public")]),
  ).toEqual(['VACUUM FULL "public"."Order""s"']);
  expect(
    maintainSql("reindex", "postgres", [table("a", "s"), table("b", "s")]),
  ).toEqual(['REINDEX TABLE "s"."a"', 'REINDEX TABLE "s"."b"']);
  expect(maintainSql("integrity-check", "sqlite", [table("t")])).toEqual([
    'PRAGMA integrity_check("t")',
  ]);
  expect(maintainSql("vacuum", "sqlite", [])).toEqual(["VACUUM"]);
  expect(() =>
    maintainSql("analyze", "postgres", [{ ...table("v"), kind: "view" }]),
  ).toThrow(/tables only/);
  expect(() => maintainSql("repair", "sqlite", [table("t")])).toThrow();
});

it("allows REPAIR only for engines that support it", () => {
  expect(repairableEngine("MyISAM")).toBe(true);
  expect(repairableEngine("Aria")).toBe(true);
  expect(repairableEngine("InnoDB")).toBe(false);
  expect(repairableEngine(undefined)).toBe(true);
  expect(
    maintainText({
      statements: [],
      rows: [{ table: "t", op: "check", msg_type: "status", msg_text: "OK" }],
      execution_ms: 1,
    }),
  ).toBe("Table\tOp\tMsg_type\tMsg_text\nt\tcheck\tstatus\tOK");
});
