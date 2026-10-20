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
import ResultGrid from "./ResultGrid";
import type { QueryResult } from "../types";
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 37,
    // Like the real virtualizer, render only a window of rows, not all 1,000+.
    getVirtualItems: () =>
      Array.from({ length: Math.min(count, 40) }, (_, index) => ({
        index,
        key: index,
        start: index * 37,
        size: 37,
      })),
  }),
}));
const clipboard = vi.fn().mockResolvedValue(undefined);
const result: QueryResult = {
  columns: ["id", "name"],
  rows: [
    [2, "Zeta"],
    [1, "Alpha"],
    [3, "Beta"],
  ],
  execution_ms: 1,
  affected_rows: 0,
  truncated: false,
  source: {
    database: "app_db",
    table: { name: "customers", schema: "", kind: "table" },
    primary_keys: ["id"],
  },
};
beforeEach(() => {
  clipboard.mockClear();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText: clipboard },
  });
  Object.defineProperty(HTMLElement.prototype, "scrollTo", {
    configurable: true,
    value: vi.fn(),
  });
});
afterEach(cleanup);
describe("row actions", () => {
  it("moves through cells with the keyboard and saves a record from the blank bottom row", async () => {
    const onApplyChanges = vi.fn().mockResolvedValue(1);
    render(<ResultGrid result={result} onApplyChanges={onApplyChanges} />);
    const beta = screen.getByRole("cell", { name: "Beta" });
    beta.focus();
    fireEvent.keyDown(beta, { key: "ArrowDown" });
    const newName = screen.getByRole("cell", { name: "New record, name" });
    await waitFor(() => expect(document.activeElement).toBe(newName));
    fireEvent.keyDown(newName, { key: "N" });
    const input = screen.getByRole("textbox", { name: "New record name" });
    fireEvent.change(input, { target: { value: "New person" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(onApplyChanges).toHaveBeenCalledWith([
        { kind: "insert", values: { name: "New person" } },
      ]),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("cell", { name: "New record, name" }),
      ),
    );
    expect(
      screen.getByRole("cell", { name: "New record, name" }).textContent,
    ).toBe("");
  });
  it("supports horizontal arrows and Tab without adding a row to custom query results", async () => {
    const { rerender } = render(
      <ResultGrid result={result} onApplyChanges={vi.fn()} />,
    );
    const zeta = screen.getByRole("cell", { name: "Zeta" });
    zeta.focus();
    fireEvent.keyDown(zeta, { key: "ArrowLeft" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("cell", { name: "2" }),
      ),
    );
    fireEvent.keyDown(document.activeElement!, { key: "Tab" });
    await waitFor(() => expect(document.activeElement).toBe(zeta));
    rerender(<ResultGrid result={{ ...result, source: undefined }} />);
    expect(screen.queryByRole("row", { name: "New record" })).toBeNull();
  });
  it("keeps a failed new-record draft so it can be corrected", async () => {
    const onApplyChanges = vi
      .fn()
      .mockRejectedValue(new Error("Required field missing"));
    render(
      <ResultGrid
        result={{ ...result, rows: [] }}
        onApplyChanges={onApplyChanges}
      />,
    );
    const newName = screen.getByRole("cell", { name: "New record, name" });
    fireEvent.keyDown(newName, { key: "A" });
    fireEvent.change(screen.getByRole("textbox", { name: "New record name" }), {
      target: { value: "Ada" },
    });
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "New record name" }),
      { key: "Enter", metaKey: true },
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Required field missing",
      ),
    );
    expect(
      (
        screen.getByRole("textbox", {
          name: "New record name",
        }) as HTMLInputElement
      ).value,
    ).toBe("Ada");
  });
  it("sorts structured tables and exposes record actions on double-click and right-click", async () => {
    const onSortChange = vi.fn();
    const onApplyChanges = vi.fn().mockResolvedValue(1);
    const onRefresh = vi.fn();
    const onFilterApply = vi.fn();
    render(
      <ResultGrid
        result={result}
        onSortChange={onSortChange}
        onApplyChanges={onApplyChanges}
        onRefresh={onRefresh}
        onFilterApply={onFilterApply}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("columnheader", { name: "name" }));
    expect(onSortChange).toHaveBeenCalledWith({
      column: "name",
      direction: "asc",
    });
    fireEvent.doubleClick(screen.getByRole("cell", { name: "Zeta" }));
    const inline = screen.getByRole("textbox", { name: "Edit name in cell" });
    fireEvent.change(inline, { target: { value: "Zeta new" } });
    fireEvent.keyDown(inline, { key: "Enter" });
    // Enter moves to the next record, which saves the edited one.
    await waitFor(() =>
      expect(onApplyChanges).toHaveBeenCalledWith([
        { kind: "update", key: { id: 2 }, values: { name: "Zeta new" } },
      ]),
    );
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Edit name in cell" }),
      ).toBeNull(),
    );
    fireEvent.contextMenu(screen.getByRole("cell", { name: "Zeta" }), {
      clientX: 40,
      clientY: 50,
    });
    expect(screen.getByRole("menuitem", { name: "Copy As" })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Sort" }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Descending" }));
    expect(onSortChange).toHaveBeenLastCalledWith({
      column: "name",
      direction: "desc",
    });
    fireEvent.contextMenu(screen.getByRole("cell", { name: "Zeta" }), {
      clientX: 40,
      clientY: 50,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Refresh" }));
    expect(onRefresh).toHaveBeenCalledOnce();
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: {
        writeText: clipboard,
        readText: vi.fn().mockResolvedValue("Pasted name"),
      },
    });
    fireEvent.contextMenu(screen.getByRole("cell", { name: "Zeta" }), {
      clientX: 40,
      clientY: 50,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Paste" }));
    const pasted = (await screen.findByRole("textbox", {
      name: "Edit name in cell",
    })) as HTMLInputElement;
    expect(pasted.value).toBe("Pasted name");
    fireEvent.keyDown(pasted, { key: "Enter" });
    await waitFor(() =>
      expect(onApplyChanges).toHaveBeenLastCalledWith([
        { kind: "update", key: { id: 2 }, values: { name: "Pasted name" } },
      ]),
    );
    fireEvent.click(screen.getByRole("button", { name: "Add record" }));
    fireEvent.change(screen.getByRole("combobox", { name: "name mode" }), {
      target: { value: "value" },
    });
    fireEvent.change(screen.getByRole("textbox", { name: "name" }), {
      target: { value: "New person" },
    });
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Add record",
      }),
    );
    await waitFor(() =>
      expect(onApplyChanges).toHaveBeenLastCalledWith([
        { kind: "insert", values: { name: "New person" } },
      ]),
    );
  });
  it("keeps icon-only record and filter actions in functional groups in the same toolbar", () => {
    render(<ResultGrid result={result} onFilterApply={vi.fn()} />);
    const filter = screen.getByRole("button", { name: "Filters" });
    const copy = screen.getByRole("button", { name: "Copy selected rows" });
    const remove = screen.getByRole("button", { name: "Delete selected rows" });
    const records = screen.getByRole("group", { name: "Record actions" });
    const search = screen.getByRole("group", { name: "Filters and search" });
    expect(
      within(records).getByRole("button", { name: "Copy selected rows" }),
    ).toBe(copy);
    expect(
      within(records).getByRole("button", { name: "Delete selected rows" }),
    ).toBe(remove);
    expect(within(search).getByRole("button", { name: "Filters" })).toBe(
      filter,
    );
    expect(records.closest(".result-toolbar")).toBe(
      search.closest(".result-toolbar"),
    );
    expect(filter.textContent).toBe("");
    expect(copy.textContent).toBe("");
    expect(remove.textContent).toBe("");
    expect(filter.getAttribute("title")).toContain("Filter table rows");
    fireEvent.click(filter);
    expect(filter.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Match all conditions (AND)")).toBeTruthy();
    fireEvent.click(filter);
    expect(filter.getAttribute("aria-expanded")).toBe("false");
  });
  it("pages raw query results and selects only rows on the visible page", () => {
    const many: QueryResult = {
      ...result,
      source: undefined,
      rows: Array.from({ length: 1005 }, (_, index) => [
        index + 1,
        `Row ${index + 1}`,
      ]),
    };
    render(<ResultGrid result={many} />);
    expect(screen.getByText("Page 1 of 2")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(screen.getByText("Page 2 of 2")).toBeTruthy();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all rows on this page" }),
    );
    expect(screen.getByText("5 selected")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Rows per page" }), {
      target: { value: "500" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Rows per page" }), {
      key: "Enter",
    });
    expect(screen.getByText("Page 1 of 3")).toBeTruthy();
    expect(
      (
        screen.getByRole("button", {
          name: "Copy selected rows",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("requests server pages instead of slicing only the first fetched batch", () => {
    const onPageChange = vi.fn();
    render(
      <ResultGrid
        result={{
          ...result,
          pagination: { page: 1, page_size: 1000, total_rows: 2500 },
        }}
        onPageChange={onPageChange}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onPageChange).toHaveBeenLastCalledWith(2, 1000);
    fireEvent.change(screen.getByRole("textbox", { name: "Rows per page" }), {
      target: { value: "2500" },
    });
    fireEvent.blur(screen.getByRole("textbox", { name: "Rows per page" }));
    expect(onPageChange).toHaveBeenLastCalledWith(1, 2500);
  });
  it("copies the selected record after sorting without changing its identity", async () => {
    render(<ResultGrid result={result} />);
    expect(
      (
        screen.getByRole("button", {
          name: "Copy selected rows",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row 1" }));
    fireEvent.click(screen.getByRole("columnheader", { name: "name" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy selected rows" }));
    await waitFor(() =>
      expect(clipboard).toHaveBeenCalledWith("id\tname\r\n2\tZeta"),
    );
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Select row 1",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
  });
  it("clears selection on filtering and selects only matching rows", () => {
    render(<ResultGrid result={result} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row 1" }));
    fireEvent.change(screen.getByRole("textbox", { name: "Filter results" }), {
      target: { value: "Beta" },
    });
    expect(
      (
        screen.getByRole("button", {
          name: "Copy selected rows",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all rows on this page" }),
    );
    expect(
      (
        screen.getByRole("checkbox", {
          name: "Select row 3",
        }) as HTMLInputElement
      ).checked,
    ).toBe(true);
    expect(screen.getByText("1 selected")).toBeTruthy();
  });
  it("requires confirmation and passes only selected rows to deletion", async () => {
    const onDelete = vi.fn().mockResolvedValue(undefined);
    render(<ResultGrid result={result} onDelete={onDelete} />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row 2" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Delete selected rows" }),
    );
    let dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("id: 1")).toBeTruthy();
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(within(dialog).getByRole("button", { name: "Cancel" }));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Delete selected rows" }),
    );
    dialog = screen.getByRole("dialog");
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete 1 row" }),
    );
    await waitFor(() => expect(onDelete).toHaveBeenCalledWith([[1, "Alpha"]]));
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
  });
  it("disables deletion for custom queries and tables without primary keys", () => {
    const { rerender } = render(
      <ResultGrid
        result={{ ...result, source: undefined }}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row 1" }));
    expect(
      (
        screen.getByRole("button", {
          name: "Delete selected rows",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("button", {
          name: "Copy selected rows",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(false);
    rerender(
      <ResultGrid
        result={{ ...result, source: { ...result.source!, primary_keys: [] } }}
        onDelete={vi.fn()}
      />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row 1" }));
    expect(
      (
        screen.getByRole("button", {
          name: "Delete selected rows",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
  });
  it("resets selection after results refresh and shows deletion errors in the dialog", async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error("Permission denied"));
    const { rerender } = render(
      <ResultGrid result={result} onDelete={onDelete} />,
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row 1" }));
    rerender(
      <ResultGrid
        result={{ ...result, rows: [[9, "New result"]] }}
        onDelete={onDelete}
      />,
    );
    expect(
      (
        screen.getByRole("button", {
          name: "Copy selected rows",
        }) as HTMLButtonElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row 1" }));
    fireEvent.click(
      screen.getByRole("button", { name: "Delete selected rows" }),
    );
    fireEvent.click(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete 1 row",
      }),
    );
    await waitFor(() =>
      expect(
        within(screen.getByRole("dialog")).getByRole("alert").textContent,
      ).toContain("Permission denied"),
    );
  });
});

it("loads quick-mode record details on demand and keeps mutations disabled", async () => {
  const onLoadRecord = vi.fn().mockResolvedValue([1, { hex: "00ff" }]);
  const onApplyChanges = vi.fn();
  const quick: QueryResult = {
    ...result,
    columns: ["id", "payload"],
    rows: [[1, { deferred: true }]],
    source: { ...result.source!, quick: true },
  };
  render(
    <ResultGrid
      result={quick}
      onLoadRecord={onLoadRecord}
      onApplyChanges={onApplyChanges}
    />,
  );
  expect(onLoadRecord).not.toHaveBeenCalled();
  fireEvent.keyDown(screen.getByRole("cell", { name: "1" }), {
    key: "s",
    ctrlKey: true,
  });
  await waitFor(() =>
    expect(screen.getByText(/This table view is read-only/)).toBeTruthy(),
  );
  expect(onApplyChanges).not.toHaveBeenCalled();
  expect(screen.queryByRole("row", { name: "New record" })).toBeNull();
  fireEvent.doubleClick(
    screen.getByRole("cell", { name: "BLOB · double-click to load" }),
  );
  await waitFor(() => expect(screen.getByRole("dialog")).toBeTruthy());
  expect(onLoadRecord).toHaveBeenCalledWith(quick.rows[0]);
  expect(screen.getByText('{"hex":"00ff"}')).toBeTruthy();
  expect(onApplyChanges).not.toHaveBeenCalled();
});
it("offers column-specific sorting on right-click and preserves the cell menu", () => {
  const onSortChange = vi.fn();
  render(
    <ResultGrid
      result={result}
      onSortChange={onSortChange}
      onFilterApply={vi.fn()}
    />,
  );
  const header = screen.getByRole("columnheader", { name: "name" });
  expect(fireEvent.contextMenu(header)).toBe(false);
  expect(
    screen.getByRole("menu", { name: "name column actions" }),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "Sort Descending" }));
  expect(onSortChange).toHaveBeenCalledWith({
    column: "name",
    direction: "desc",
  });
  fireEvent.contextMenu(screen.getByRole("cell", { name: "Alpha" }));
  expect(
    screen.queryByRole("menu", { name: "name column actions" }),
  ).toBeNull();
  expect(screen.getByRole("menuitem", { name: "Copy" })).toBeTruthy();
});

it("keeps content-sized headers, records and the new-record row aligned while filtering", () => {
  const { container } = render(
    <ResultGrid
      result={{
        ...result,
        rows: [
          [1, "x".repeat(200)],
          [2, "Short"],
        ],
      }}
      onApplyChanges={vi.fn()}
    />,
  );
  const header = container.querySelector<HTMLElement>(".grid-head")!;
  const template = header.style.gridTemplateColumns;
  expect(template).toBe("34px 48px 96px 300px");
  for (const row of container.querySelectorAll<HTMLElement>(".grid-row")) {
    expect(row.style.gridTemplateColumns).toBe(template);
  }
  expect(
    container.querySelector<HTMLElement>(".grid-new-row")!.style.minWidth,
  ).toBe(header.style.minWidth);
  fireEvent.change(screen.getByRole("textbox", { name: "Filter results" }), {
    target: { value: "Short" },
  });
  expect(header.style.gridTemplateColumns).toBe(template);
});

it("resizes the header and every record without triggering sort, and double-click restores auto width", () => {
  const onSortChange = vi.fn();
  const { container } = render(
    <ResultGrid
      result={result}
      onApplyChanges={vi.fn()}
      onSortChange={onSortChange}
    />,
  );
  const handle = screen.getByRole("separator", { name: "Resize name column" });
  const initial = Number(handle.getAttribute("aria-valuenow"));
  fireEvent(
    handle,
    new MouseEvent("pointerdown", { bubbles: true, button: 0, clientX: 100 }),
  );
  fireEvent(window, new MouseEvent("pointermove", { clientX: 140 }));
  fireEvent(window, new MouseEvent("pointerup"));
  expect(handle.getAttribute("aria-valuenow")).toBe(String(initial + 40));
  const template =
    container.querySelector<HTMLElement>(".grid-head")!.style
      .gridTemplateColumns;
  for (const row of container.querySelectorAll<HTMLElement>(".grid-row"))
    expect(row.style.gridTemplateColumns).toBe(template);
  expect(onSortChange).not.toHaveBeenCalled();
  fireEvent.doubleClick(handle);
  expect(handle.getAttribute("aria-valuenow")).toBe(String(initial));
});
