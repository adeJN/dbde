// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import App from "./App";
import { useWorkspace } from "./store";
import type { ConnectionConfig, QueryResult } from "./types";
const { viewTable, deleteRows, insertRecord, updateCell } = vi.hoisted(() => ({
  viewTable: vi.fn(),
  deleteRows: vi.fn(),
  insertRecord: vi.fn(),
  updateCell: vi.fn(),
}));
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 37,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 37,
        size: 37,
      })),
  }),
}));
vi.mock("./components/QueryEditor", () => ({
  default: ({ value }: { value: string }) => (
    <textarea aria-label="SQL text" defaultValue={value} />
  ),
}));
vi.mock("./lib/api", () => ({
  desktop: true,
  listProfiles: async () => [],
  viewTable,
  deleteRows,
  insertRecord,
  updateCell,
  schema: async () => ({ database: "workspace", tables: [] }),
}));
const config: ConnectionConfig = {
  id: "server",
  name: "Local SQLite",
  driver: "sqlite",
  host: "",
  port: 0,
  username: "",
  database: "workspace",
  file_path: ":memory:",
  ssl_mode: "disable",
};
const table = { name: "customers", schema: "", kind: "table" };
const result: QueryResult = {
  columns: ["id", "name"],
  rows: [[1, "Ada"]],
  affected_rows: 0,
  execution_ms: 1,
  truncated: false,
  source: { database: "workspace", table, primary_keys: ["id"] },
};
beforeEach(() => {
  deleteRows.mockReset();
  deleteRows.mockResolvedValue(1);
  insertRecord.mockReset();
  insertRecord.mockResolvedValue(1);
  updateCell.mockReset();
  updateCell.mockResolvedValue(1);
  viewTable.mockReset();
  viewTable.mockResolvedValue(result);
  useWorkspace.setState({
    sessions: [
      {
        id: "server",
        config,
        databases: ["workspace"],
        trees: { workspace: { database: "workspace", tables: [table] } },
      },
    ],
    tabs: [
      {
        id: "table-tab",
        name: "customers",
        connectionId: "server",
        database: "workspace",
        query: "SELECT * FROM customers;",
        result,
        running: false,
      },
    ],
    activeTab: "table-tab",
  });
});
afterEach(cleanup);
describe("table-first workspace", () => {
  it("reloads the page where a newly inserted record can appear", async () => {
    useWorkspace.getState().updateTab("table-tab", {
      result: {
        ...result,
        pagination: { page: 1, page_size: 1000, total_rows: 1000 },
      },
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Add record" }));
    fireEvent.change(screen.getByRole("combobox", { name: "name mode" }), {
      target: { value: "value" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "name" }), {
      target: { value: "New" },
    });
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Add record",
      }),
    );
    await waitFor(() =>
      expect(insertRecord).toHaveBeenCalledWith("server", result.source, {
        name: "New",
      }),
    );
    await waitFor(() =>
      expect(viewTable).toHaveBeenCalledWith(
        "server",
        "workspace",
        table,
        2,
        1000,
        [],
        undefined,
      ),
    );
  });
  it("returns to the new last page after deletion and synchronizes the SQL preview", async () => {
    useWorkspace.getState().updateTab("table-tab", {
      result: {
        ...result,
        rows: [[1001, "Last row"]],
        pagination: { page: 2, page_size: 1000, total_rows: 1001 },
      },
      query: "SELECT * FROM customers LIMIT 1000 OFFSET 1000;",
    });
    viewTable.mockResolvedValue({
      ...result,
      pagination: { page: 1, page_size: 1000, total_rows: 1000 },
    });
    render(<App />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row 1" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Delete selected rows" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete 1 row",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
    expect(deleteRows).toHaveBeenCalledWith("server", result.source, [
      { id: 1001 },
    ]);
    expect(viewTable).toHaveBeenCalledWith(
      "server",
      "workspace",
      table,
      2,
      1000,
      [],
      undefined,
    );
    const current = useWorkspace
      .getState()
      .tabs.find((t) => t.id === "table-tab")!;
    expect(current.result?.pagination?.page).toBe(1);
    expect(current.query).not.toContain("OFFSET 1000");
  });
  it("preserves the selected page and page size when refreshing a table", async () => {
    useWorkspace.getState().updateTab("table-tab", {
      result: {
        ...result,
        pagination: { page: 2, page_size: 250, total_rows: 1500 },
      },
    });
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Refresh table data" }));
    await waitFor(() =>
      expect(viewTable).toHaveBeenCalledWith(
        "server",
        "workspace",
        table,
        2,
        250,
        [],
        undefined,
      ),
    );
  });
  it("starts table views with SQL hidden and restores it on demand", async () => {
    render(<App />);
    expect(document.getElementById("sql-editor-panel")?.hidden).toBe(true);
    expect(screen.queryByRole("textbox", { name: "SQL text" })).toBeNull();
    expect(screen.getByRole("table", { name: "Query results" })).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Show SQL editor" }));
    expect(
      await screen.findByRole("textbox", { name: "SQL text" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Hide SQL editor" }));
    expect(document.getElementById("sql-editor-panel")?.hidden).toBe(true);
  });
  it("focuses the table while keeping row actions reachable and restores the explorer", () => {
    const { container } = render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Focus table" }));
    expect(
      container.querySelector(".app")?.classList.contains("table-focused"),
    ).toBe(true);
    expect(
      screen
        .getByRole("button", { name: "Show explorer" })
        .getAttribute("aria-expanded"),
    ).toBe("false");
    expect(
      screen.getByRole("button", { name: "Copy selected rows" }),
    ).toBeTruthy();
    expect(
      screen.getByRole("button", { name: "Delete selected rows" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Exit table focus" }));
    expect(
      container.querySelector(".app")?.classList.contains("table-focused"),
    ).toBe(false);
    expect(screen.getByRole("button", { name: "Hide explorer" })).toBeTruthy();
  });
  it("opens Explorer tables with a collapsed editor and refreshes via the structured table API", async () => {
    render(<App />);
    fireEvent.click(
      within(screen.getByRole("complementary")).getByRole("button", {
        name: "customers",
      }),
    );
    await waitFor(() =>
      expect(viewTable).toHaveBeenCalledWith(
        "server",
        "workspace",
        table,
        1,
        1000,
        [],
        undefined,
      ),
    );
    expect(
      useWorkspace
        .getState()
        .tabs.find((t) => t.id === useWorkspace.getState().activeTab)
        ?.editorOpen,
    ).toBe(false);
    await waitFor(() =>
      expect(
        (
          screen.getByRole("button", {
            name: "Refresh table data",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(false),
    );
    fireEvent.click(screen.getByRole("button", { name: "Refresh table data" }));
    await waitFor(() => expect(viewTable).toHaveBeenCalledTimes(2));
  });
  it("reuses an already opened Explorer table tab", async () => {
    render(<App />);
    const tableButton = within(screen.getByRole("complementary")).getByRole(
      "button",
      { name: "customers" },
    );
    fireEvent.click(tableButton);
    await waitFor(() => expect(viewTable).toHaveBeenCalledTimes(1));
    const opened = useWorkspace.getState().activeTab;
    fireEvent.click(tableButton);
    expect(useWorkspace.getState().activeTab).toBe(opened);
    expect(useWorkspace.getState().tabs).toHaveLength(2);
    expect(viewTable).toHaveBeenCalledTimes(1);
  });
});
