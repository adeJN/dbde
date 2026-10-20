import { beforeEach, expect, it, vi } from "vitest";
const execute = vi.hoisted(() => vi.fn());
vi.mock("./api", () => ({ execute }));
import { loadTableDetails, splitFieldType } from "./table-structure";
const result = (columns: string[], rows: unknown[][]) => ({
  columns,
  rows,
  affected_rows: 0,
  execution_ms: 0,
  truncated: false,
});
beforeEach(() => {
  execute.mockReset();
});
it("splits display lengths and decimal scale without interpreting enum values as dimensions", () => {
  expect(splitFieldType("decimal(10,2) unsigned")).toEqual({
    type: "decimal unsigned",
    length: "10",
    decimals: "2",
  });
  expect(splitFieldType("int(11)")).toEqual({
    type: "int",
    length: "11",
    decimals: "",
  });
  expect(splitFieldType("enum('a','b')").length).toBe("");
});
it("reads MySQL details, groups composite foreign keys, and distinguishes default expressions from virtual fields", async () => {
  execute.mockImplementation(async (_id, sql: string) => {
    if (sql.includes("information_schema.COLUMNS"))
      return result(
        [
          "name",
          "full_type",
          "default_value",
          "charset",
          "collation",
          "comment",
          "extra",
          "expression",
          "column_key",
          "nullable",
        ],
        [
          [
            "created",
            "timestamp",
            "CURRENT_TIMESTAMP",
            null,
            null,
            "Created at",
            "DEFAULT_GENERATED",
            "",
            "",
            "YES",
          ],
          [
            "total",
            "decimal(10,2)",
            null,
            null,
            null,
            "",
            "VIRTUAL GENERATED",
            "qty * price",
            "",
            "YES",
          ],
        ],
      );
    if (sql.includes("KEY_COLUMN_USAGE"))
      return result(
        [
          "name",
          "field",
          "ref_schema",
          "ref_table",
          "ref_field",
          "update_rule",
          "delete_rule",
        ],
        [
          ["fk_pair", "a", "app", "other", "a", "CASCADE", "RESTRICT"],
          ["fk_pair", "b", "app", "other", "b", "CASCADE", "RESTRICT"],
        ],
      );
    if (sql.includes("information_schema.TABLES"))
      return result(["engine", "comment"], [["InnoDB", "Orders"]]);
    return result([], []);
  });
  const details = await loadTableDetails(
    "mysql",
    "app",
    { name: "order' OR 1=1 --", schema: "app", kind: "table" },
    "mysql",
  );
  expect(details.fields[0].generated).toBe(false);
  expect(details.fields[1]).toMatchObject({
    generated: true,
    expression: "qty * price",
    length: "10",
    decimals: "2",
  });
  expect(details.foreignKeys).toHaveLength(1);
  expect(details.foreignKeys[0].definition).toContain(
    "(a, b) → app.other (a, b)",
  );
  expect(details.options.engine).toBe("InnoDB");
  expect(details.comment).toBe("Orders");
  expect(
    execute.mock.calls.every(
      (call) => /^SELECT /i.test(call[1]) && !call[1].includes("order' OR"),
    ),
  ).toBe(true);
});
it("reports unavailable metadata rather than confusing permission failures with an empty section", async () => {
  execute.mockImplementation(async (_id, sql: string) => {
    if (sql.includes("CHECK_CONSTRAINTS")) throw new Error("Access denied");
    return result([], []);
  });
  const details = await loadTableDetails(
    "mysql",
    "app",
    { name: "orders", schema: "app", kind: "table" },
    "mysql",
  );
  expect(details.unavailable).toEqual(["Checks"]);
});
