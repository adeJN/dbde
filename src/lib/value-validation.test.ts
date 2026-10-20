import { describe, expect, it } from "vitest";
import { validateChanges, validateValue } from "./value-validation";
import type { Driver } from "../types";
const check = (
  type: string,
  value: string | null,
  nullable = false,
  driver: Driver = "mysql",
) =>
  validateValue({ name: "amount", data_type: type, nullable }, value, driver);
describe("database literal validation", () => {
  it.each([
    ["int", "abc"],
    ["int", "1.5"],
    ["int", ""],
    ["tinyint unsigned", "256"],
    ["tinyint unsigned", "-1"],
    ["bigint", "9223372036854775808"],
    ["smallint", "32768"],
    ["decimal(5,2)", "1000"],
    ["decimal(5,2)", "1.001"],
    ["decimal(5,2)", "1e3"],
    ["double", "Infinity"],
    ["double", "1,25"],
    ["double", "1e999"],
    ["varchar(3)", "abcd"],
    ["json", "{bad}"],
    ["boolean", "yes"],
    ["uuid", "bad"],
    ["date", "2025-02-29"],
    ["date", "2026-04-31"],
    ["datetime", "2026-01-01 25:00:00"],
    ["datetime", "2026-01-01"],
    ["time", "839:00:00"],
    ["time", "10:60:00"],
    ["enum('open','closed')", "OPEN"],
    ["set('red','blue')", "red,green"],
  ])("rejects %s value %s", (type, value) =>
    expect(check(type, value)).toBeTruthy(),
  );
  it.each([
    ["int", "-12"],
    ["bigint unsigned", "18446744073709551615"],
    ["decimal(5,2)", "999.99"],
    ["decimal(5,2)", "0001.2300"],
    ["decimal(5,2)", "1e-2"],
    ["varchar(3)", "😀ab"],
    ["json", '{"ok":true}'],
    ["boolean", "false"],
    ["date", "2024-02-29"],
    ["datetime", "2026-10-15 12:34:56.123"],
    ["time", "-838:59:59"],
    ["enum('open','closed')", "open"],
    ["set('red','blue')", "red,blue"],
  ])("accepts %s value %s", (type, value) =>
    expect(check(type, value)).toBeUndefined(),
  );
  it("checks NULL independently from empty text and omitted defaults", () => {
    expect(check("text", null)).toContain("NULL");
    expect(check("text", null, true)).toBeUndefined();
    expect(check("text", "")).toBeUndefined();
    expect(() =>
      validateChanges(
        [{ name: "amount", data_type: "int", nullable: false }],
        [{ kind: "insert", values: {} }],
      ),
    ).not.toThrow();
  });
  it("supports PostgreSQL formatted types and preserves Unicode character counts", () => {
    expect(
      check("character varying(2)", "😀a", true, "postgres"),
    ).toBeUndefined();
    expect(
      check(
        "timestamp with time zone",
        "2026-01-01T12:00:00+07:00",
        false,
        "postgres",
      ),
    ).toBeUndefined();
    expect(
      check(
        "timestamp without time zone",
        "2026-01-01T12:00:00Z",
        false,
        "postgres",
      ),
    ).toBeTruthy();
    expect(check("integer", "2147483648", false, "postgres")).toBeTruthy();
    expect(check("INTEGER", "2147483648", false, "sqlite")).toBeUndefined();
  });
  it("reports the failing record and column without mutating the batch", () => {
    const changes = [
      { kind: "insert" as const, values: { amount: "ok" } },
      { kind: "insert" as const, values: { amount: "no" } },
    ];
    expect(() =>
      validateChanges(
        [{ name: "amount", data_type: "enum('ok')", nullable: false }],
        changes,
        "mysql",
      ),
    ).toThrow("Record 2: amount");
    expect(changes[1].values.amount).toBe("no");
  });
});
