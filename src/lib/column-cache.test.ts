import { expect, it, vi } from "vitest";
import { createColumnCache } from "./column-cache";
const table = { name: "people", schema: "public", kind: "table" };
it("deduplicates requests but reloads columns after a schema refresh", async () => {
  const load = vi
    .fn()
    .mockResolvedValueOnce([
      { name: "old_name", data_type: "text", nullable: true },
    ])
    .mockResolvedValueOnce([
      { name: "new_name", data_type: "text", nullable: true },
    ]);
  const read = createColumnCache(load);
  const first = [table];
  const pending = read(first, "server", "app", table);
  expect(read(first, "server", "app", table)).toBe(pending);
  expect((await pending)[0].name).toBe("old_name");
  expect((await read([...first], "server", "app", table))[0].name).toBe(
    "new_name",
  );
  expect(load).toHaveBeenCalledTimes(2);
});
it("isolates databases/connections and retries failed metadata reads", async () => {
  const load = vi
    .fn()
    .mockRejectedValueOnce(new Error("temporary error"))
    .mockResolvedValue([]);
  const read = createColumnCache(load),
    tables = [table];
  await expect(read(tables, "server", "app", table)).rejects.toThrow(
    "temporary",
  );
  await read(tables, "server", "app", table);
  await read(tables, "server", "other", table);
  await read(tables, "different-server", "app", table);
  expect(load).toHaveBeenCalledTimes(4);
});
