import { describe, expect, it, vi } from "vitest";
import { createExplorerLoader, matchingTables } from "./explorer-search";
const tables = ["customers", "orders"].map((name) => ({
  name,
  schema: "public",
  kind: "table",
}));
describe("explorer database and table search", () => {
  it("matches database names, table names, case and surrounding whitespace", () => {
    expect(matchingTables("Interior", tables, " INTERIOR ")).toEqual(tables);
    expect(matchingTables("Interior", tables, " CUST ")).toEqual([tables[0]]);
    expect(matchingTables("Interior", tables, "missing")).toEqual([]);
    expect(matchingTables("Interior", tables, "  ")).toEqual(tables);
  });
  it("bounds simultaneous schema reads and shares in-flight requests", async () => {
    const finish: (() => void)[] = [];
    const fetch = vi.fn(
      (id: string, database: string) =>
        new Promise<{ database: string; tables: typeof tables }>((resolve) =>
          finish.push(() => resolve({ database, tables })),
        ),
    );
    const load = createExplorerLoader(fetch, 2);
    const a = load("server", "a"),
      b = load("server", "b"),
      c = load("server", "c");
    expect(load("server", "a")).toBe(a);
    expect(fetch).toHaveBeenCalledTimes(2);
    finish.shift()!();
    await a;
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(3));
    finish.shift()!();
    finish.shift()!();
    await Promise.all([b, c]);
  });
  it("releases a failed slot so other databases can still be searched and retried", async () => {
    const fetch = vi
      .fn()
      .mockRejectedValueOnce(new Error("permission denied"))
      .mockResolvedValue({ database: "b", tables });
    const load = createExplorerLoader(fetch, 1);
    const first = load("server", "a"),
      next = load("server", "b");
    await expect(first).rejects.toThrow("permission denied");
    expect(await next).toEqual({ database: "b", tables });
    await expect(load("server", "a")).resolves.toBeTruthy();
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});
