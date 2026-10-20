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
import type { QueryResult } from "../types";
const api = vi.hoisted(() => ({
  desktop: true,
  columns: vi.fn(),
  saveFile: vi.fn(),
  exportTable: vi.fn(),
  exportRows: vi.fn(),
  cancelExport: vi.fn(),
}));
vi.mock("../lib/api", () => api);
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
import ResultGrid from "./ResultGrid";

const table = { name: "customers", schema: "", kind: "table" };
const filters = [{ column: "name", operator: "contains" as const, value: "a" }];
const sort = { column: "id", direction: "desc" as const };
const tableResult: QueryResult = {
  columns: ["id", "name"],
  rows: [
    [2, "Zeta"],
    [1, "Alpha"],
  ],
  execution_ms: 1,
  affected_rows: 0,
  truncated: false,
  pagination: { page: 1, page_size: 1000, total_rows: 2 },
  source: { database: "app_db", table, primary_keys: ["id"], filters, sort },
};
const summary = {
  path: "/tmp/customers.csv",
  rows: 2,
  sheets: 1,
  truncated_cells: 0,
};
beforeEach(() => {
  api.columns.mockReset().mockResolvedValue([]);
  api.exportTable.mockReset().mockResolvedValue(summary);
  api.exportRows.mockReset().mockResolvedValue(summary);
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(cleanup);
describe("grid export", () => {
  it("opens the wizard for the current table with the grid's filters and sort", async () => {
    render(
      <ResultGrid
        result={tableResult}
        connectionId="local"
        driver="postgres"
        onPageChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Export…/ }));
    const wizard = screen.getByRole("dialog", { name: /Export customers/ });
    expect(
      (
        within(wizard).getByRole("radio", {
          name: /current filter and sort/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.click(within(wizard).getByRole("button", { name: /Export…/ }));
    await waitFor(() =>
      expect(api.exportTable).toHaveBeenCalledWith(
        "local",
        "app_db",
        table,
        expect.objectContaining({ columns: ["id", "name"] }),
        { filters, sort },
        expect.any(String),
        expect.any(Function),
      ),
    );
    expect(
      await screen.findByText("Exported 2 rows to /tmp/customers.csv."),
    ).toBeTruthy();
  });
  it("offers the ticked rows, and exports fetched rows of a custom query", async () => {
    const { unmount } = render(
      <ResultGrid
        result={tableResult}
        connectionId="local"
        onPageChange={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row 1" }));
    fireEvent.click(screen.getByRole("button", { name: /Export…/ }));
    expect(
      (
        screen.getByRole("radio", {
          name: "Selected rows (1)",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.click(screen.getAllByRole("button", { name: /Export…/ }).at(-1)!);
    await waitFor(() =>
      expect(api.exportRows).toHaveBeenCalledWith(
        "local",
        "app_db",
        table,
        expect.anything(),
        [[2, "Zeta"]],
        expect.any(String),
        expect.any(Function),
      ),
    );
    unmount();
    const { source: _source, pagination: _pagination, ...query } = tableResult;
    render(<ResultGrid result={query} connectionId="local" />);
    fireEvent.click(screen.getByRole("button", { name: /Export…/ }));
    expect(
      screen.getByRole("radio", { name: "All fetched rows (2)" }),
    ).toBeTruthy();
    expect(
      screen.queryByRole("radio", { name: /All rows in the table/ }),
    ).toBeNull();
    fireEvent.click(screen.getAllByRole("button", { name: /Export…/ }).at(-1)!);
    await waitFor(() =>
      expect(api.exportRows).toHaveBeenLastCalledWith(
        "local",
        undefined,
        undefined,
        expect.anything(),
        [
          [2, "Zeta"],
          [1, "Alpha"],
        ],
        expect.any(String),
        expect.any(Function),
      ),
    );
  });
});
describe("grid import", () => {
  it("offers Import… next to Export… for table views only", () => {
    const onImport = vi.fn();
    render(
      <ResultGrid
        result={tableResult}
        connectionId="local"
        onImport={onImport}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Import…/ }));
    expect(onImport).toHaveBeenCalledTimes(1);
    cleanup();
    render(
      <ResultGrid
        result={{ ...tableResult, source: undefined }}
        connectionId="local"
        onImport={onImport}
      />,
    );
    expect(screen.queryByRole("button", { name: /Import…/ })).toBeNull();
  });
});
