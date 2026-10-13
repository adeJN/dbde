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
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
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
    const onInsertRecord = vi.fn().mockResolvedValue(1);
    render(<ResultGrid result={result} onInsertRecord={onInsertRecord} />);
    const beta = screen.getByRole("cell", { name: "Beta" });
    beta.focus();
    fireEvent.keyDown(beta, { key: "ArrowDown" });
    const newName = screen.getByRole("cell", { name: "New record, name" });
    await waitFor(() => expect(document.activeElement).toBe(newName));
    fireEvent.keyDown(newName, { key: "N" });
    const input = screen.getByRole("textbox", { name: "New record name" });
    fireEvent.change(input, { target: { value: "New person" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() => expect(newName.textContent).toBe("New person"));
    fireEvent.keyDown(newName, { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(onInsertRecord).toHaveBeenCalledWith({ name: "New person" }),
    );
    await waitFor(() => expect(newName.textContent).toBe(""));
  });
  it("supports horizontal arrows and Tab without adding a row to custom query results", async () => {
    const { rerender } = render(
      <ResultGrid result={result} onInsertRecord={vi.fn()} />,
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
    const onInsertRecord = vi
      .fn()
      .mockRejectedValue(new Error("Required field missing"));
    render(
      <ResultGrid
        result={{ ...result, rows: [] }}
        onInsertRecord={onInsertRecord}
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
    const onUpdateCell = vi.fn().mockResolvedValue(1);
    const onInsertRecord = vi.fn().mockResolvedValue(1);
    const onRefresh = vi.fn();
    const onFilterApply = vi.fn();
    render(
      <ResultGrid
        result={result}
        onSortChange={onSortChange}
        onUpdateCell={onUpdateCell}
        onInsertRecord={onInsertRecord}
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
    expect(screen.getByText("Record details")).toBeTruthy();
    fireEvent.change(screen.getByRole("textbox", { name: "Edit name" }), {
      target: { value: "Zeta new" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Save cell" }));
    await waitFor(() =>
      expect(onUpdateCell).toHaveBeenCalledWith(
        [2, "Zeta"],
        "name",
        "Zeta new",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
    await waitFor(() =>
      expect(
        (
          screen.getByRole("textbox", {
            name: "Edit name",
          }) as HTMLTextAreaElement
        ).value,
      ).toBe("Pasted name"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Save cell" }));
    await waitFor(() =>
      expect(onUpdateCell).toHaveBeenLastCalledWith(
        [2, "Zeta"],
        "name",
        "Pasted name",
      ),
    );
    await waitFor(() => expect(screen.queryByRole("dialog")).toBeNull());
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
      expect(onInsertRecord).toHaveBeenCalledWith({ name: "New person" }),
    );
  });
  it("groups icon-only filter, copy, and delete actions in one toolbar row", () => {
    render(<ResultGrid result={result} onFilterApply={vi.fn()} />);
    const filter = screen.getByRole("button", { name: "Filters" });
    const copy = screen.getByRole("button", { name: "Copy selected rows" });
    const remove = screen.getByRole("button", { name: "Delete selected rows" });
    const group = filter.parentElement;
    expect(group?.classList.contains("row-actions")).toBe(true);
    expect(copy.parentElement).toBe(group);
    expect(remove.parentElement).toBe(group);
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
