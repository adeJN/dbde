import { describe, expect, it } from "vitest";
import { rowKeys, rowsAsTsv } from "./rows";
import type { QueryResult } from "../types";
const result: QueryResult = {
  columns: ["tenant", "name", "id"],
  rows: [],
  affected_rows: 0,
  execution_ms: 0,
  truncated: false,
  source: {
    database: "app",
    table: { name: "items", schema: "", kind: "table" },
    primary_keys: ["tenant", "id"],
  },
};
describe("row clipboard and identity", () => {
  it("copies headers and preserves tabs, newlines, quotes and NULL safely", () => {
    expect(
      rowsAsTsv(["id", "note", "optional"], [[1, 'a\tb\n"c"', null]]),
    ).toBe('id\tnote\toptional\r\n1\t"a\tb\n""c"""\t');
    expect(rowsAsTsv(["value"], [["=1+1"]])).toBe("value\r\n'=1+1");
    expect(rowsAsTsv(["n", "s"], [[-5, "-12.50"]])).toBe("n\ts\r\n-5\t-12.50");
  });
  it("extracts complete composite keys without including other column values", () => {
    expect(rowKeys(result, [["a", "Name", 2]])).toEqual([
      { tenant: "a", id: 2 },
    ]);
    expect(rowKeys(result, [["x' OR 1=1 --", "Name", 2]])).toEqual([
      { tenant: "x' OR 1=1 --", id: 2 },
    ]);
  });
  it("rejects missing, NULL, binary and imprecise key values", () => {
    expect(() => rowKeys({ ...result, source: undefined }, [])).toThrow();
    expect(() =>
      rowKeys({ ...result, columns: ["tenant"] }, [["a"]]),
    ).toThrow();
    for (const key of [null, { hex: "ff" }, 9007199254740992])
      expect(() => rowKeys(result, [["a", "Name", key]])).toThrow();
  });
});
