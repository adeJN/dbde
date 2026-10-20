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
const api = vi.hoisted(() => ({
  desktop: true,
  exportTable: vi.fn(),
  exportRows: vi.fn(),
  cancelExport: vi.fn(),
}));
vi.mock("../lib/api", () => api);
import ExportDialog, { type ExportRequest } from "./ExportDialog";

const table = { name: "orders", schema: "", kind: "table" };
const base: ExportRequest = {
  connectionId: "local",
  database: "shop",
  driver: "mysql",
  table,
  columns: ["id", "customer", "total"],
};
const summary = {
  path: "/tmp/orders.csv",
  rows: 3,
  sheets: 1,
  truncated_cells: 0,
};
beforeEach(() => {
  api.desktop = true;
  api.exportTable.mockReset().mockResolvedValue(summary);
  api.exportRows.mockReset().mockResolvedValue(summary);
  api.cancelExport.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);
const exportButton = () => screen.getByRole("button", { name: /Export…/ });
function renderDialog(request: Partial<ExportRequest> = {}) {
  const onDone = vi.fn();
  const onClose = vi.fn();
  render(
    <ExportDialog
      request={{ ...base, ...request }}
      onDone={onDone}
      onClose={onClose}
    />,
  );
  return { onDone, onClose };
}

describe("export wizard", () => {
  it("defaults to CSV of every column with Excel-safe options and exports the whole table", async () => {
    const { onDone } = renderDialog();
    expect(screen.getByRole("dialog", { name: /Export orders/ })).toBeTruthy();
    const csv = screen.getByRole("radio", { name: "CSV" }) as HTMLInputElement;
    expect(csv.checked).toBe(true);
    expect(document.activeElement).toBe(csv);
    const columns = within(
      screen.getByRole("group", { name: "Columns to export" }),
    );
    expect(
      columns
        .getAllByRole("checkbox")
        .every((box) => (box as HTMLInputElement).checked),
    ).toBe(true);
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Protect against spreadsheet formulas",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(screen.queryByRole("radio", { name: /current filter/ })).toBeNull();
    fireEvent.click(exportButton());
    await waitFor(() => expect(onDone).toHaveBeenCalledWith(summary));
    const [connectionId, database, sent, options, view, id] =
      api.exportTable.mock.lastCall!;
    expect([connectionId, database, sent, view]).toEqual([
      "local",
      "shop",
      table,
      {},
    ]);
    expect(id).toMatch(/^[0-9a-f-]{36}$/);
    expect(options).toMatchObject({
      format: "csv",
      columns: ["id", "customer", "total"],
      header: true,
      delimiter: ",",
      quote: '"',
      null_text: "",
      protect_formulas: true,
      bom: true,
      create_table: false,
    });
  });
  it("exports the filtered view with chosen columns as SQL with CREATE TABLE", async () => {
    const view = {
      filters: [{ column: "total", operator: "contains" as const, value: "9" }],
      sort: { column: "id", direction: "desc" as const },
    };
    renderDialog({ view });
    expect(
      (
        screen.getByRole("radio", {
          name: /current filter and sort/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "customer" }));
    expect(screen.getByText(/2 columns of 3/)).toBeTruthy();
    fireEvent.click(screen.getByRole("radio", { name: "SQL INSERT" }));
    expect(
      screen.queryByRole("checkbox", { name: /Protect against/ }),
    ).toBeNull();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Include CREATE TABLE" }),
    );
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Rows per INSERT" }),
      {
        target: { value: "500" },
      },
    );
    fireEvent.click(exportButton());
    await waitFor(() => expect(api.exportTable).toHaveBeenCalled());
    const [, , , options, sentView] = api.exportTable.mock.lastCall!;
    expect(sentView).toEqual(view);
    expect(options).toMatchObject({
      format: "sql",
      columns: ["id", "total"],
      create_table: true,
      batch_size: 500,
    });
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Rows per INSERT" }),
      {
        target: { value: "0" },
      },
    );
  });
  it("blocks invalid choices with a reason", () => {
    renderDialog();
    fireEvent.click(screen.getByRole("button", { name: "None" }));
    expect(screen.getByRole("alert").textContent).toMatch(
      /at least one column/,
    );
    expect((exportButton() as HTMLButtonElement).disabled).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "All" }));
    fireEvent.click(screen.getByRole("radio", { name: "SQL INSERT" }));
    fireEvent.change(
      screen.getByRole("spinbutton", { name: "Rows per INSERT" }),
      {
        target: { value: "5000" },
      },
    );
    expect(screen.getByRole("alert").textContent).toMatch(/1 and 1,000/);
  });
  it("writes only the selected rows, projected to the chosen columns", async () => {
    renderDialog({
      selectedRows: [
        [1, "Ana", 10],
        [2, "Bo", null],
      ],
    });
    const selected = screen.getByRole("radio", {
      name: "Selected rows (2)",
    }) as HTMLInputElement;
    expect(selected.checked).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "customer" }));
    fireEvent.click(screen.getByRole("radio", { name: "JSON" }));
    fireEvent.click(exportButton());
    await waitFor(() => expect(api.exportRows).toHaveBeenCalled());
    const [connectionId, database, sent, options, rows] =
      api.exportRows.mock.lastCall!;
    expect([connectionId, database, sent]).toEqual(["local", "shop", table]);
    expect(options.columns).toEqual(["id", "total"]);
    expect(rows).toEqual([
      [1, 10],
      [2, null],
    ]);
  });
  it("needs a table name for SQL from query results and keeps Quick-mode rows out", async () => {
    renderDialog({
      table: undefined,
      database: "",
      fetchedRows: [[1, "a", 2]],
      selectedRows: [[1, { deferred: true }, 2]],
    });
    expect(
      screen.getByRole("dialog", { name: /Export query results/ }),
    ).toBeTruthy();
    expect(
      (
        screen.getByRole("radio", {
          name: /All fetched rows \(1\)/,
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(
      screen.getByRole("radio", { name: /Selected rows/ }).closest("label")!
        .title,
    ).toMatch(/Quick mode/);
    fireEvent.click(screen.getByRole("radio", { name: "SQL INSERT" }));
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Include CREATE TABLE",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    expect(screen.getByRole("alert").textContent).toMatch(/table name/);
    fireEvent.change(
      screen.getByRole("textbox", { name: "Table name for INSERT" }),
      {
        target: { value: "report" },
      },
    );
    fireEvent.click(exportButton());
    await waitFor(() => expect(api.exportRows).toHaveBeenCalled());
    const [, database, sent, options, rows] = api.exportRows.mock.lastCall!;
    expect([database, sent, options.table_name, rows]).toEqual([
      undefined,
      undefined,
      "report",
      [[1, "a", 2]],
    ]);
  });
  it("shows progress, cancels by export ID and stays open with the outcome", async () => {
    let finish: (value: null) => void = () => {};
    api.exportTable.mockImplementation(
      (_c, _d, _t, _o, _v, _id, onProgress: (rows: number) => void) => {
        onProgress(12000);
        return new Promise((resolve) => (finish = resolve));
      },
    );
    const { onDone, onClose } = renderDialog();
    fireEvent.click(exportButton());
    expect((await screen.findByRole("status")).textContent).toMatch(
      new RegExp(`${(12000).toLocaleString()} rows written`),
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Cancel export" }));
    const id = api.exportTable.mock.lastCall![5];
    expect(api.cancelExport).toHaveBeenCalledWith(id);
    finish(null);
    expect((await screen.findByText(/Export cancelled/)).textContent).toMatch(
      /No file/,
    );
    expect(onDone).not.toHaveBeenCalled();
    api.exportTable.mockRejectedValueOnce("Unknown column nope");
    fireEvent.click(exportButton());
    expect((await screen.findByRole("alert")).textContent).toBe(
      "Unknown column nope",
    );
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
  it("offers Excel only in the desktop app", () => {
    api.desktop = false;
    renderDialog();
    expect(
      (screen.getByRole("radio", { name: "Excel (.xlsx)" }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
  });
});
