import { expect, it } from "vitest";
import { tableFilterClause } from "./sql";
import type { Driver, TableFilter } from "../types";
it("builds bound OR and mixed AND/OR clauses for every driver", () => {
  const filters: TableFilter[] = [
    { column: "a", operator: "equals", value: "x' OR 1=1" },
    { column: "b", operator: "is_null", value: "", join: "or" },
    { column: "c", operator: "equals", value: "z" },
  ];
  for (const driver of ["postgres", "mysql", "sqlite"] as Driver[]) {
    const clause = tableFilterClause(filters, driver);
    expect(clause.sql).toContain(" OR ");
    expect(clause.sql).toContain(" AND ");
    expect(clause.sql).not.toContain("1=1");
    expect(clause.values).toEqual(["x' OR 1=1", "z"]);
    expect(tableFilterClause(filters, driver, true).sql).toContain(" OR ");
  }
  expect(() =>
    tableFilterClause(
      [{ ...filters[0], join: "OR 1=1" } as unknown as TableFilter],
      "sqlite",
    ),
  ).toThrow();
});
