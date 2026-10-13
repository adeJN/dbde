import { describe, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({ isTauri: () => true, invoke }));
import {
  listDatabases,
  execute,
  schema,
  columns,
  viewTable,
  deleteRows,
  insertRecord,
  updateCell,
  closeSession,
} from "./api";

describe("desktop server browsing IPC", () => {
  it("passes validated sort and record mutations through structured commands", async () => {
    const table = { name: "customers", schema: "public", kind: "table" };
    const source = { database: "app_db", table, primary_keys: ["id"] };
    invoke.mockResolvedValueOnce({ columns: [], rows: [] });
    await viewTable("server", "app_db", table, 1, 50, [], {
      column: "name",
      direction: "desc",
    });
    expect(invoke).toHaveBeenLastCalledWith("dbde_view_table", {
      connectionId: "server",
      database: "app_db",
      table,
      page: 1,
      pageSize: 50,
      sort: { column: "name", direction: "desc" },
    });
    invoke.mockResolvedValueOnce(1);
    await updateCell("server", source, { id: 2 }, "name", "New");
    expect(invoke).toHaveBeenLastCalledWith("dbde_update_cell", {
      connectionId: "server",
      database: "app_db",
      table,
      key: { id: 2 },
      column: "name",
      value: "New",
    });
    invoke.mockResolvedValueOnce(1);
    await insertRecord("server", source, { name: "Ada", note: null });
    expect(invoke).toHaveBeenLastCalledWith("dbde_insert_record", {
      connectionId: "server",
      database: "app_db",
      table,
      values: { name: "Ada", note: null },
    });
  });
  it("passes page and page size to native table browsing", async () => {
    invoke.mockResolvedValueOnce({ columns: [], rows: [] });
    const table = { name: "customers", schema: "public", kind: "table" };
    await viewTable("server", "app_db", table, 3, 500);
    expect(invoke).toHaveBeenLastCalledWith("dbde_view_table", {
      connectionId: "server",
      database: "app_db",
      table,
      page: 3,
      pageSize: 500,
    });
  });
  it("sends structured table and key data for deletion instead of raw SQL", async () => {
    invoke.mockResolvedValueOnce({ columns: [], rows: [] });
    const table = { name: "customers", schema: "public", kind: "table" };
    await viewTable("server", "app_db", table);
    expect(invoke).toHaveBeenLastCalledWith("dbde_view_table", {
      connectionId: "server",
      database: "app_db",
      table,
      page: 1,
      pageSize: 1000,
    });
    invoke.mockResolvedValueOnce(1);
    expect(
      await deleteRows(
        "server",
        { database: "app_db", table, primary_keys: ["id"] },
        [{ id: "a' OR 1=1 --" }],
      ),
    ).toBe(1);
    expect(invoke).toHaveBeenLastCalledWith("dbde_delete_rows", {
      connectionId: "server",
      database: "app_db",
      table,
      keys: [{ id: "a' OR 1=1 --" }],
    });
  });
  it("requests all databases without an initial database filter", async () => {
    invoke.mockResolvedValueOnce(["analytics", "app_db"]);
    expect(await listDatabases("server")).toEqual(["analytics", "app_db"]);
    expect(invoke).toHaveBeenLastCalledWith("dbde_list_databases", {
      connectionId: "server",
    });
  });
  it("passes each tab's database to execution, schema, and column lookups", async () => {
    invoke.mockResolvedValue(undefined);
    await execute("server", "SELECT * FROM orders", "analytics");
    expect(invoke).toHaveBeenLastCalledWith("dbde_execute_query", {
      connectionId: "server",
      query: "SELECT * FROM orders",
      database: "analytics",
    });
    await execute("server", "SELECT * FROM orders", "app_db");
    expect(invoke).toHaveBeenLastCalledWith("dbde_execute_query", {
      connectionId: "server",
      query: "SELECT * FROM orders",
      database: "app_db",
    });
    await execute("server", "BEGIN", "app_db", "tab-1");
    expect(invoke).toHaveBeenLastCalledWith("dbde_execute_query", {
      connectionId: "server",
      query: "BEGIN",
      database: "app_db",
      sessionId: "tab-1",
    });
    await closeSession("server", "tab-1");
    expect(invoke).toHaveBeenLastCalledWith("dbde_close_session", {
      connectionId: "server",
      sessionId: "tab-1",
    });
    await schema("server", "analytics");
    expect(invoke).toHaveBeenLastCalledWith("dbde_get_schema_tree", {
      connectionId: "server",
      database: "analytics",
    });
    const table = { name: "orders", schema: "public", kind: "table" };
    await columns("server", table, "app_db");
    expect(invoke).toHaveBeenLastCalledWith("dbde_get_columns", {
      connectionId: "server",
      table,
      database: "app_db",
    });
  });
});
