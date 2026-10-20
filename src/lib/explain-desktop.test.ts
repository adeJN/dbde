import { expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  isTauri: () => true,
  invoke,
  Channel: class {},
}));
import { explain, maintainTables } from "./api";

it("sends explain and maintenance requests to the backend commands", async () => {
  invoke.mockResolvedValue({});
  await explain("conn", "SELECT 1", "app", "tab-1", true, false, 120);
  expect(invoke).toHaveBeenLastCalledWith("dbde_explain_query", {
    connectionId: "conn",
    query: "SELECT 1",
    database: "app",
    sessionId: "tab-1",
    analyze: true,
    allowWrite: false,
    timeoutSecs: 120,
  });
  const table = { name: "t", schema: "public", kind: "table" };
  await maintainTables("conn", "app", [table], "vacuum-full", 600);
  expect(invoke).toHaveBeenLastCalledWith("dbde_maintain_tables", {
    connectionId: "conn",
    database: "app",
    tables: [table],
    operation: "vacuum-full",
    timeoutSecs: 600,
  });
  await maintainTables("conn", "app", [table], "analyze");
  expect(invoke.mock.lastCall?.[1]).not.toHaveProperty("timeoutSecs");
});
