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
import * as api from "../lib/api";
import type { QueryResult } from "../types";
vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 37,
    scrollToIndex: () => {},
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 37,
        size: 37,
      })),
  }),
}));
const result: QueryResult = {
  columns: ["id", "name", "note"],
  rows: [
    [2, "Zeta", null],
    [1, "Alpha", "first"],
    [3, "Beta", "third"],
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
const writeText = vi.fn().mockResolvedValue(undefined);
const readText = vi.fn();
beforeEach(() => {
  writeText.mockClear();
  readText.mockReset();
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText, readText },
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
const cell = (name: string) => screen.getByRole("cell", { name });
function focus(name: string) {
  const element = cell(name);
  element.focus();
  return element;
}
const editor = (column: string) =>
  screen.getByRole("textbox", {
    name: `Edit ${column} in cell`,
  }) as HTMLInputElement;
const update = (id: number, values: Record<string, string | null>) => ({
  kind: "update",
  key: { id },
  values,
});
function grid(overrides: Partial<Parameters<typeof ResultGrid>[0]> = {}) {
  const props = {
    result,
    onApplyChanges: vi.fn().mockResolvedValue(1),
    onDelete: vi.fn().mockResolvedValue(undefined),
    driver: "postgres" as const,
    ...overrides,
  };
  return { props, ...render(<ResultGrid {...props} />) };
}
describe("record edits are kept until the record is left (Navicat)", () => {
  it("saves a record when Enter moves the cursor to another record", async () => {
    const { props } = grid();
    fireEvent.keyDown(focus("Zeta"), { key: "Z" });
    expect(editor("name").value).toBe("Z");
    fireEvent.change(editor("name"), { target: { value: "Zed" } });
    fireEvent.keyDown(editor("name"), { key: "Enter" });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(2, { name: "Zed" }),
      ]),
    );
    await waitFor(() => expect(document.activeElement).toBe(cell("Alpha")));
  });
  it("keeps edits within a record pending, marks them, and saves on leaving", async () => {
    const { props } = grid();
    fireEvent.keyDown(focus("first"), { key: "Enter" });
    fireEvent.change(editor("note"), { target: { value: "changed" } });
    fireEvent.keyDown(editor("note"), { key: "Tab", shiftKey: true });
    await waitFor(() => expect(document.activeElement).toBe(cell("Alpha")));
    fireEvent.keyDown(cell("Alpha"), { key: "A" });
    fireEvent.change(editor("name"), { target: { value: "Alfa" } });
    fireEvent.keyDown(editor("name"), { key: "Tab" });
    expect(props.onApplyChanges).not.toHaveBeenCalled();
    expect(cell("changed").className).toContain("modified");
    expect(screen.getByText("1 change pending")).toBeTruthy();
    expect(screen.getByLabelText("unsaved changes")).toBeTruthy();
    fireEvent.keyDown(cell("changed"), { key: "ArrowDown" });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(1, { name: "Alfa", note: "changed" }),
      ]),
    );
  });
  it("Escape discards the record's changes; unchanged values write nothing", async () => {
    const { props } = grid();
    fireEvent.keyDown(focus("Alpha"), { key: "Enter" });
    fireEvent.keyDown(editor("name"), { key: "Tab" });
    fireEvent.keyDown(cell("first"), { key: "x" });
    fireEvent.keyDown(editor("note"), { key: "Tab", shiftKey: true });
    expect(cell("x").className).toContain("modified");
    fireEvent.keyDown(cell("Alpha"), { key: "Escape" });
    expect(cell("first")).toBeTruthy();
    fireEvent.keyDown(cell("Alpha"), { key: "ArrowDown" });
    await waitFor(() => expect(document.activeElement).toBe(cell("Beta")));
    expect(props.onApplyChanges).not.toHaveBeenCalled();
  });
  it("Ctrl/⌘+S saves; Ctrl/⌘+Shift+Backspace sets NULL while editing", async () => {
    const { props } = grid();
    fireEvent.keyDown(focus("third"), { key: "Backspace" });
    expect(editor("note").value).toBe("");
    fireEvent.keyDown(editor("note"), {
      key: "Backspace",
      metaKey: true,
      shiftKey: true,
    });
    fireEvent.keyDown(screen.getAllByRole("cell", { name: "NULL" })[1], {
      key: "s",
      ctrlKey: true,
    });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(3, { note: null }),
      ]),
    );
  });
  it("edits a primary key and another field using the original key until saved", async () => {
    const { props } = grid();
    fireEvent.keyDown(focus("2"), { key: "9" });
    fireEvent.keyDown(editor("id"), { key: "Tab" });
    expect(cell("9").className).toContain("modified");
    fireEvent.keyDown(cell("Zeta"), { key: "X" });
    fireEvent.keyDown(editor("name"), { key: "Enter" });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(2, { id: "9", name: "X" }),
      ]),
    );
  });
  it("retains a rejected primary key edit so it can be corrected or discarded", async () => {
    const { props } = grid({
      onApplyChanges: vi
        .fn()
        .mockRejectedValue(new Error("Duplicate primary key")),
    });
    fireEvent.doubleClick(focus("2"));
    fireEvent.change(editor("id"), { target: { value: "1" } });
    fireEvent.keyDown(editor("id"), { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Duplicate primary key",
      ),
    );
    expect(props.onApplyChanges).toHaveBeenCalledWith([update(2, { id: "1" })]);
    expect(
      screen
        .getAllByRole("cell", { name: "1" })
        .some((e) => e.className.includes("modified")),
    ).toBe(true);
  });
  it("keeps a change that failed to save, with the error", async () => {
    grid({
      onApplyChanges: vi.fn().mockRejectedValue(new Error("value too long")),
    });
    fireEvent.keyDown(focus("Beta"), { key: "x" });
    fireEvent.keyDown(editor("name"), { key: "Enter" });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("value too long"),
    );
    expect(cell("x").className).toContain("modified");
  });
  it("returns focus to the next cell after the parent refreshes the result", async () => {
    let rerender: ReturnType<typeof render>["rerender"] = () => {};
    const onApplyChanges = vi.fn(async () => {
      rerender(
        <ResultGrid
          result={{
            ...result,
            rows: [[2, "Zed", null], ...result.rows.slice(1)],
          }}
          onApplyChanges={onApplyChanges}
        />,
      );
      return 1;
    });
    ({ rerender } = render(
      <ResultGrid result={result} onApplyChanges={onApplyChanges} />,
    ));
    fireEvent.keyDown(focus("Zeta"), { key: "Enter" });
    fireEvent.change(editor("name"), { target: { value: "Zed" } });
    fireEvent.keyDown(editor("name"), { key: "Enter" });
    await waitFor(() => expect(cell("Zed")).toBeTruthy());
    await waitFor(() => expect(document.activeElement).toBe(cell("Alpha")));
    expect(screen.queryByText(/pending$/)).toBeNull();
  });
  it("saves pending edits before moving to another page", async () => {
    const onPageChange = vi.fn();
    const { props } = grid({
      onPageChange,
      result: {
        ...result,
        pagination: { page: 1, page_size: 3, total_rows: 6 },
      },
    });
    fireEvent.keyDown(focus("Zeta"), { key: "Q" });
    fireEvent.keyDown(editor("name"), { key: "Tab" });
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    await waitFor(() => expect(onPageChange).toHaveBeenCalledWith(2, 3));
    expect(props.onApplyChanges).toHaveBeenCalledWith([
      update(2, { name: "Q" }),
    ]);
  });
});
describe("transactions", () => {
  it("collects edits, deletions and new records until Commit", async () => {
    const { props } = grid();
    fireEvent.click(screen.getByRole("button", { name: /Begin Transaction/ }));
    fireEvent.keyDown(focus("Zeta"), { key: "Z" });
    fireEvent.keyDown(editor("name"), { key: "Enter" });
    fireEvent.keyDown(cell("Alpha"), { key: "Delete", ctrlKey: true });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(cell("Alpha").closest('[role="row"]')!.className).toContain(
      "pending-delete",
    );
    fireEvent.keyDown(cell("Beta"), {
      key: "d",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(props.onApplyChanges).not.toHaveBeenCalled();
    expect(screen.getByText("3 changes pending")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Commit/ }));
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(2, { name: "Z" }),
        { kind: "delete", key: { id: 1 } },
        { kind: "insert", values: { name: "Beta", note: "third" } },
      ]),
    );
    expect(
      screen.getByRole("button", { name: /Begin Transaction/ }),
    ).toBeTruthy();
  });
  it("Rollback drops everything without writing", () => {
    const { props } = grid();
    fireEvent.click(screen.getByRole("button", { name: /Begin Transaction/ }));
    fireEvent.keyDown(focus("Zeta"), { key: "Z" });
    fireEvent.keyDown(editor("name"), { key: "Enter" });
    fireEvent.click(screen.getByRole("button", { name: /Rollback/ }));
    expect(cell("Zeta")).toBeTruthy();
    expect(screen.queryByText(/pending$/)).toBeNull();
    expect(props.onApplyChanges).not.toHaveBeenCalled();
  });
});
describe("blocks of cells", () => {
  it("selects a block with Shift+arrows and fills it by typing", async () => {
    const { props } = grid();
    const zeta = focus("Zeta");
    fireEvent.keyDown(zeta, { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(cell("NULL"), { key: "ArrowDown", shiftKey: true });
    expect(cell("Zeta").className).toContain("in-range");
    expect(cell("first").className).toContain("in-range");
    expect(cell("Beta").className).not.toContain("in-range");
    fireEvent.keyDown(cell("first"), { key: "k" });
    fireEvent.keyDown(editor("note"), { key: "Enter" });
    // Several records changed at once are written right away, in one call.
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(2, { name: "k", note: "k" }),
        update(1, { name: "k", note: "k" }),
      ]),
    );
  });
  it("copies a block as TSV and pastes a block, adding rows below as drafts", async () => {
    const { props } = grid();
    fireEvent.keyDown(focus("Alpha"), { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(cell("Beta"), { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(cell("third"), { key: "c", ctrlKey: true });
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("Alpha\tfirst\r\nBeta\tthird"),
    );
    readText.mockResolvedValue("n1\tm1\r\nn2\tm2\r\nn3\tm3\r\n");
    fireEvent.keyDown(focus("Beta"), { key: "Escape" });
    fireEvent.keyDown(cell("Beta"), { key: "v", ctrlKey: true });
    await waitFor(() =>
      expect(
        screen.getByRole("cell", { name: "Copy 1, name" }).textContent,
      ).toBe("n2"),
    );
    expect(cell("n1").className).toContain("modified");
    expect(screen.getByRole("cell", { name: "Copy 2, note" }).textContent).toBe(
      "m3",
    );
    expect(props.onApplyChanges).not.toHaveBeenCalled();
    fireEvent.keyDown(cell("n1"), { key: "s", metaKey: true });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(3, { name: "n1", note: "m1" }),
        { kind: "insert", values: { name: "n2", note: "m2" } },
        { kind: "insert", values: { name: "n3", note: "m3" } },
      ]),
    );
  });
  it("selects one or several records with row-number clicks and mouse dragging", async () => {
    const { container } = grid();
    const numbers = () =>
      Array.from(
        container.querySelectorAll<HTMLElement>(".grid-row .row-number"),
      );
    const selectedRows = () =>
      container.querySelectorAll(".grid-row[aria-selected='true']");
    expect(fireEvent.mouseDown(numbers()[0], { button: 0 })).toBe(false);
    fireEvent.mouseUp(window);
    expect(selectedRows()).toHaveLength(1);
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.mouseDown(numbers()[0], { button: 0 });
    fireEvent.mouseEnter(numbers()[2].closest(".grid-row")!, { buttons: 1 });
    fireEvent.mouseUp(window);
    expect(selectedRows()).toHaveLength(3);
    expect(screen.getByText("3 selected")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Copy selected rows" }));
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    expect(writeText.mock.lastCall?.[0]).toContain("Zeta");
    expect(writeText.mock.lastCall?.[0]).toContain("Beta");
    fireEvent.mouseDown(numbers()[0], { button: 0 });
    fireEvent.mouseUp(window);
    fireEvent.mouseDown(numbers()[2], { button: 0, shiftKey: true });
    fireEvent.mouseUp(window);
    expect(selectedRows()).toHaveLength(3);
    fireEvent.mouseDown(numbers()[1], { button: 0, metaKey: true });
    fireEvent.mouseUp(window);
    expect(selectedRows()).toHaveLength(2);
    fireEvent.mouseDown(numbers()[1], { button: 0, metaKey: true });
    fireEvent.mouseUp(window);
    expect(selectedRows()).toHaveLength(3);
  });
  it("selects a block by dragging and by Shift+click without native text selection", () => {
    grid();
    const clearNativeSelection = vi.spyOn(
      window.getSelection()!,
      "removeAllRanges",
    );
    expect(fireEvent.mouseDown(cell("Zeta"), { button: 0 })).toBe(false);
    expect(clearNativeSelection).toHaveBeenCalledOnce();
    expect(document.activeElement).toBe(cell("Zeta"));
    fireEvent.mouseEnter(cell("first"), { buttons: 1 });
    expect(cell("Zeta").className).toContain("in-range");
    expect(cell("first").className).toContain("in-range");
    fireEvent.mouseUp(window);
    fireEvent.mouseDown(cell("2"), { button: 0 });
    fireEvent.click(cell("2"));
    fireEvent.mouseDown(cell("Beta"), { button: 0, shiftKey: true });
    expect(cell("1").className).toContain("in-range");
    expect(cell("third").className).not.toContain("in-range");
  });
});
describe("cell menu", () => {
  const open = (name: string) =>
    fireEvent.contextMenu(cell(name), { clientX: 10, clientY: 10 });
  it("sets empty strings, NULL and UUIDs, staged until the record is left", async () => {
    const { props } = grid();
    vi.spyOn(crypto, "randomUUID").mockReturnValue(
      "123e4567-e89b-12d3-a456-426614174000",
    );
    open("first");
    fireEvent.click(screen.getByRole("menuitem", { name: "Set to NULL" }));
    open("Alpha");
    fireEvent.click(screen.getByRole("menuitem", { name: "Generate UUID" }));
    expect(props.onApplyChanges).not.toHaveBeenCalled();
    fireEvent.keyDown(focus("Zeta"), { key: "s", ctrlKey: true });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(1, {
          note: null,
          name: "123e4567-e89b-12d3-a456-426614174000",
        }),
      ]),
    );
    open("Beta");
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Set to Empty String" }),
    );
    fireEvent.keyDown(focus("Zeta"), { key: "s", ctrlKey: true });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenLastCalledWith([
        update(3, { name: "" }),
      ]),
    );
  });
  it("copies records as INSERT and UPDATE statements and TSV variants", async () => {
    grid();
    const copyAs = (item: string) => {
      open("Alpha");
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy As" }));
      fireEvent.click(screen.getByRole("menuitem", { name: item }));
    };
    copyAs("Insert Statement");
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        `INSERT INTO "customers" ("id", "name", "note") VALUES (1, 'Alpha', 'first');`,
      ),
    );
    copyAs("Update Statement");
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        `UPDATE "customers" SET "name" = 'Alpha', "note" = 'first' WHERE "id" = 1;`,
      ),
    );
    copyAs("Tab Separated Values (Field Name only)");
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith("id\tname\tnote"),
    );
    copyAs("Tab Separated Values (Field Name and Data)");
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        "id\tname\tnote\r\n1\tAlpha\tfirst",
      ),
    );
  });
});
describe("row commands", () => {
  it("selects rows with Space, Shift+Arrow, Ctrl/⌘+A and clears with Escape", () => {
    grid();
    const zeta = focus("Zeta");
    fireEvent.keyDown(zeta, { key: " " });
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.keyDown(zeta, { key: "ArrowDown", shiftKey: true });
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.keyDown(cell("Alpha"), { key: "a", ctrlKey: true });
    expect(screen.getByText("3 selected")).toBeTruthy();
    fireEvent.keyDown(cell("Alpha"), { key: "Escape" });
    expect(screen.queryByText(/selected$/)).toBeNull();
  });
  it("moves with Navicat's Ctrl/⌘+arrow keys", async () => {
    grid();
    fireEvent.keyDown(focus("Alpha"), { key: "ArrowRight", ctrlKey: true });
    await waitFor(() => expect(document.activeElement).toBe(cell("first")));
    fireEvent.keyDown(cell("first"), { key: "ArrowDown", metaKey: true });
    await waitFor(() => expect(document.activeElement).toBe(cell("third")));
    fireEvent.keyDown(cell("third"), { key: "PageUp", ctrlKey: true });
    await waitFor(() => expect(document.activeElement).toBe(cell("NULL")));
    fireEvent.keyDown(cell("NULL"), { key: "ArrowLeft", ctrlKey: true });
    await waitFor(() => expect(document.activeElement).toBe(cell("2")));
  });
  it("deletes the focused row with Ctrl/⌘+Delete after confirmation", async () => {
    const { props } = grid();
    fireEvent.keyDown(focus("Alpha"), { key: "Delete", ctrlKey: true });
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("id: 1")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete 1 row" }),
    );
    await waitFor(() =>
      expect(props.onDelete).toHaveBeenCalledWith([[1, "Alpha", "first"]]),
    );
  });
  it("deletes the selected rows with Ctrl/⌘+Backspace", () => {
    grid();
    fireEvent.keyDown(focus("Zeta"), { key: " " });
    fireEvent.keyDown(cell("Beta"), { key: " " });
    fireEvent.keyDown(cell("Beta"), { key: "Backspace", metaKey: true });
    expect(
      within(screen.getByRole("dialog")).getByRole("button", {
        name: "Delete 2 rows",
      }),
    ).toBeTruthy();
  });
  it("copies a row below without its key and saves it", async () => {
    const { props } = grid();
    fireEvent.keyDown(focus("Alpha"), {
      key: "d",
      ctrlKey: true,
      shiftKey: true,
    });
    const copyName = screen.getByRole("cell", { name: "Copy 1, name" });
    await waitFor(() => expect(document.activeElement).toBe(copyName));
    expect(copyName.textContent).toBe("Alpha");
    expect(screen.getByRole("cell", { name: "Copy 1, id" }).textContent).toBe(
      "",
    );
    fireEvent.keyDown(copyName, { key: "Enter", metaKey: true });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        { kind: "insert", values: { name: "Alpha", note: "first" } },
      ]),
    );
    await waitFor(() =>
      expect(screen.queryByRole("row", { name: "Copy 1" })).toBeNull(),
    );
  });
  it("copies several selected rows, keeps NULL, and saves them together", async () => {
    const { props } = grid();
    fireEvent.click(screen.getByRole("button", { name: /Begin Transaction/ }));
    fireEvent.keyDown(focus("Zeta"), { key: " " });
    fireEvent.keyDown(cell("Beta"), { key: " " });
    fireEvent.keyDown(cell("Beta"), {
      key: "d",
      metaKey: true,
      shiftKey: true,
    });
    expect(screen.getByRole("row", { name: "Copy 1" })).toBeTruthy();
    expect(screen.getByRole("row", { name: "Copy 2" })).toBeTruthy();
    expect(screen.getByRole("cell", { name: "Copy 1, note" }).textContent).toBe(
      "NULL",
    );
    const copyTwo = screen.getByRole("cell", { name: "Copy 2, name" });
    fireEvent.keyDown(copyTwo, { key: "Enter" });
    fireEvent.change(screen.getByRole("textbox", { name: "Copy 2 name" }), {
      target: { value: "Beta 2" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Copy 2 name" }), {
      key: "Tab",
    });
    fireEvent.click(screen.getByRole("button", { name: /Commit/ }));
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        { kind: "insert", values: { name: "Zeta", note: null } },
        { kind: "insert", values: { name: "Beta 2", note: "third" } },
      ]),
    );
  });
  it("removes a pending copy and keeps all copies when saving fails", async () => {
    grid({
      onApplyChanges: vi
        .fn()
        .mockRejectedValue(
          new Error(
            "Change 2 of 2 (new record): duplicate key. Nothing was saved.",
          ),
        ),
    });
    fireEvent.keyDown(focus("Zeta"), { key: "a", ctrlKey: true });
    fireEvent.keyDown(cell("Zeta"), {
      key: "d",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.getAllByRole("row", { name: /^Copy / })).toHaveLength(3);
    fireEvent.click(screen.getByRole("button", { name: "Remove Copy 2" }));
    expect(screen.getAllByRole("row", { name: /^Copy / })).toHaveLength(2);
    fireEvent.keyDown(screen.getByRole("cell", { name: "Copy 1, name" }), {
      key: "Enter",
      ctrlKey: true,
    });
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain(
        "Nothing was saved",
      ),
    );
    expect(screen.getAllByRole("row", { name: /^Copy / })).toHaveLength(2);
    fireEvent.keyDown(screen.getByRole("cell", { name: "Copy 1, name" }), {
      key: "Delete",
      ctrlKey: true,
    });
    expect(screen.getAllByRole("row", { name: /^Copy / })).toHaveLength(1);
  });
  it("duplicates from the toolbar and the context menu", () => {
    grid();
    fireEvent.keyDown(focus("Zeta"), { key: " " });
    fireEvent.click(
      screen.getByRole("button", { name: "Duplicate selected rows" }),
    );
    expect(screen.getAllByRole("row", { name: /^Copy / })).toHaveLength(1);
    fireEvent.contextMenu(cell("Beta"), { clientX: 10, clientY: 10 });
    fireEvent.click(
      screen.getByRole("menuitem", { name: "Duplicate Record Below" }),
    );
    expect(screen.getAllByRole("row", { name: /^Copy / })).toHaveLength(2);
  });
  it("jumps to the new record row with Ctrl/⌘+I, Ctrl/⌘+N and Insert", async () => {
    grid();
    const newName = () =>
      screen.getByRole("cell", { name: "New record, name" });
    fireEvent.keyDown(focus("Zeta"), { key: "i", metaKey: true });
    await waitFor(() => expect(document.activeElement).toBe(newName()));
    fireEvent.keyDown(focus("Beta"), { key: "n", ctrlKey: true });
    await waitFor(() => expect(document.activeElement).toBe(newName()));
    fireEvent.keyDown(focus("2"), { key: "Insert" });
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("cell", { name: "New record, id" }),
      ),
    );
  });
  it("copies a cell and pastes into the editor; Enter saves on leaving", async () => {
    const { props } = grid();
    fireEvent.keyDown(focus("Beta"), { key: "c", ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalledWith("Beta"));
    readText.mockResolvedValue("Gamma");
    fireEvent.keyDown(focus("Alpha"), { key: "v", ctrlKey: true });
    await waitFor(() => expect(editor("name").value).toBe("Gamma"));
    expect(props.onApplyChanges).not.toHaveBeenCalled();
    fireEvent.keyDown(editor("name"), { key: "Enter" });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(1, { name: "Gamma" }),
      ]),
    );
  });
  it("opens read-only details instead of editing custom query results", () => {
    grid({ result: { ...result, source: undefined } });
    fireEvent.keyDown(focus("Zeta"), { key: "Enter" });
    expect(screen.getByText("Record details")).toBeTruthy();
    expect(
      screen.queryByRole("textbox", { name: "Edit name in cell" }),
    ).toBeNull();
  });
});
describe("leaving the editor with the mouse", () => {
  it("keeps a changed draft on blur and saves when another record is focused", async () => {
    const { props } = grid();
    fireEvent.keyDown(focus("Zeta"), { key: "Q" });
    const other = cell("third");
    other.focus(); // Blurs the editor, as a click elsewhere would.
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(2, { name: "Q" }),
      ]),
    );
    expect(document.activeElement).toBe(other);
  });
  it("does nothing when an unchanged editor loses focus", async () => {
    const { props } = grid();
    fireEvent.keyDown(focus("Zeta"), { key: "Enter" });
    cell("third").focus();
    await waitFor(() =>
      expect(
        screen.queryByRole("textbox", { name: "Edit name in cell" }),
      ).toBeNull(),
    );
    expect(props.onApplyChanges).not.toHaveBeenCalled();
  });
});
describe("keyboard position highlight", () => {
  it("moves the active cell and row highlight with the arrow keys", async () => {
    grid();
    const zeta = cell("Zeta");
    fireEvent.click(zeta);
    expect(zeta.className).toContain("active");
    fireEvent.keyDown(zeta, { key: "ArrowDown" });
    await waitFor(() => expect(cell("Alpha").className).toContain("active"));
    expect(cell("Zeta").className).not.toContain(" active");
    expect(cell("Alpha").closest('[role="row"]')!.className).toContain(
      "active-row",
    );
    fireEvent.keyDown(cell("Beta"), { key: "ArrowDown" });
    const newName = screen.getByRole("cell", { name: "New record, name" });
    await waitFor(() => expect(newName.className).toContain("active"));
  });
});

describe("bottom-row insertion navigation", () => {
  it("keeps a trailing blank row and saves only when Tab leaves the draft", async () => {
    const { props } = grid();
    fireEvent.keyDown(focus("New record, name"), { key: "N" });
    expect(cell("New record, name").textContent).toBe("");
    const input = screen.getByRole("textbox", { name: "New record name" });
    fireEvent.keyDown(input, { key: "Tab" });
    await waitFor(() =>
      expect(document.activeElement).toBe(cell("Draft 1, note")),
    );
    expect(props.onApplyChanges).not.toHaveBeenCalled();
    fireEvent.keyDown(cell("Draft 1, note"), { key: "x" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Draft 1 note" }), {
      key: "Tab",
    });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        { kind: "insert", values: { name: "N", note: "x" } },
      ]),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(cell("New record, id")),
    );
    expect(props.onApplyChanges).toHaveBeenCalledTimes(1);
  });
  it("Shift Tab wraps from an editing draft to the previous record and saves it", async () => {
    const { props } = grid();
    fireEvent.keyDown(focus("New record, id"), { key: "4" });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "New record id" }), {
      key: "Tab",
      shiftKey: true,
    });
    await waitFor(() => expect(document.activeElement).toBe(cell("third")));
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        { kind: "insert", values: { id: "4" } },
      ]),
    );
  });
  it("returns to the failed draft with its values intact and allows retry", async () => {
    const apply = vi
      .fn()
      .mockRejectedValueOnce(new Error("Required field"))
      .mockResolvedValue(1);
    grid({ onApplyChanges: apply });
    fireEvent.keyDown(focus("New record, name"), { key: "N" });
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "New record name" }),
      { key: "Enter" },
    );
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("Required field"),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(cell("Draft 1, name")),
    );
    expect(cell("Draft 1, name").textContent).toBe("N");
    fireEvent.keyDown(cell("Draft 1, name"), { key: "ArrowDown" });
    await waitFor(() => expect(apply).toHaveBeenCalledTimes(2));
    await waitFor(() =>
      expect(document.activeElement).toBe(cell("New record, name")),
    );
  });
  it("leaves new records pending inside a transaction until Commit", async () => {
    const { props } = grid();
    fireEvent.click(screen.getByRole("button", { name: /Begin Transaction/ }));
    fireEvent.keyDown(focus("New record, name"), { key: "N" });
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "New record name" }),
      { key: "Enter" },
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(cell("New record, name")),
    );
    expect(cell("Draft 1, name").textContent).toBe("N");
    expect(props.onApplyChanges).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Commit/ }));
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        { kind: "insert", values: { name: "N" } },
      ]),
    );
  });
  it("does not insert when navigating or saving an untouched blank row", async () => {
    const { props } = grid();
    fireEvent.keyDown(focus("third"), { key: "Tab" });
    await waitFor(() =>
      expect(document.activeElement).toBe(cell("New record, id")),
    );
    fireEvent.keyDown(cell("New record, id"), { key: "s", metaKey: true });
    fireEvent.keyDown(cell("New record, id"), { key: "ArrowUp" });
    await waitFor(() => expect(document.activeElement).toBe(cell("3")));
    expect(props.onApplyChanges).not.toHaveBeenCalled();
  });
  it("keeps the blank-row focus after an insert refresh changes the data row count", async () => {
    let rerender: ReturnType<typeof render>["rerender"];
    const onApplyChanges = vi.fn(async () => {
      rerender(
        <ResultGrid
          result={{ ...result, rows: [...result.rows, [4, "N", null]] }}
          onApplyChanges={onApplyChanges}
        />,
      );
      return 1;
    });
    ({ rerender } = render(
      <ResultGrid result={result} onApplyChanges={onApplyChanges} />,
    ));
    fireEvent.keyDown(focus("New record, name"), { key: "N" });
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "New record name" }),
      { key: "ArrowDown" },
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(cell("New record, name")),
    );
    await waitFor(() => expect(cell("N")).toBeTruthy());
    expect(onApplyChanges).toHaveBeenCalledTimes(1);
  });
});

describe("new-record safety", () => {
  it("Command plus opens the blank row and clean Command S never inserts", async () => {
    const { props } = grid();
    fireEvent.keyDown(focus("Beta"), { key: "s", metaKey: true });
    await waitFor(() => expect(props.onApplyChanges).not.toHaveBeenCalled());
    fireEvent.keyDown(focus("Beta"), {
      key: "+",
      metaKey: true,
      shiftKey: true,
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(cell("New record, name")),
    );
    expect(props.onApplyChanges).not.toHaveBeenCalled();
  });
  it("auto-saves only the draft being left and preserves the next pending copy", async () => {
    const { props } = grid();
    fireEvent.keyDown(focus("Zeta"), { key: " " });
    fireEvent.keyDown(cell("Beta"), { key: " " });
    fireEvent.keyDown(cell("Beta"), {
      key: "d",
      metaKey: true,
      shiftKey: true,
    });
    await waitFor(() =>
      expect(document.activeElement).toBe(cell("Copy 1, name")),
    );
    fireEvent.keyDown(cell("Copy 1, name"), { key: "ArrowDown" });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        { kind: "insert", values: { name: "Zeta", note: null } },
      ]),
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(cell("Copy 1, name")),
    );
    expect(cell("Copy 1, name").textContent).toBe("Beta");
    expect(cell("New record, name").textContent).toBe("");
    expect(props.onApplyChanges).toHaveBeenCalledTimes(1);
  });
});

describe("typed column editors", () => {
  it("keeps an invalid integer edit open and saves after correction", async () => {
    const api = await import("../lib/api");
    vi.spyOn(api, "columns").mockResolvedValue([
      { name: "id", data_type: "int", nullable: false },
      { name: "name", data_type: "int", nullable: false },
      { name: "note", data_type: "varchar(3)", nullable: true },
    ]);
    const { props } = grid({ connectionId: "typed" });
    await waitFor(() => expect(api.columns).toHaveBeenCalled());
    await waitFor(() =>
      expect(
        within(screen.getByRole("columnheader", { name: "note" })).getByText(
          "varchar(3)",
        ),
      ).toBeTruthy(),
    );
    expect(screen.getByRole("columnheader", { name: "note" }).title).toContain(
      "note · varchar(3)",
    );
    fireEvent.keyDown(focus("Alpha"), { key: "x" });
    fireEvent.keyDown(editor("name"), { key: "Enter" });
    expect(editor("name").getAttribute("aria-invalid")).toBe("true");
    expect(screen.getByRole("alert").textContent).toContain("name (int)");
    expect(props.onApplyChanges).not.toHaveBeenCalled();
    fireEvent.change(editor("name"), { target: { value: "42" } });
    fireEvent.keyDown(editor("name"), { key: "Enter" });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(1, { name: "42" }),
      ]),
    );
  });
  it("blocks invalid draft navigation without losing the typed value", async () => {
    const api = await import("../lib/api");
    vi.spyOn(api, "columns").mockResolvedValue([
      { name: "id", data_type: "int", nullable: false },
      { name: "name", data_type: "int", nullable: false },
      { name: "note", data_type: "text", nullable: true },
    ]);
    const { props } = grid({ connectionId: "typed" });
    await waitFor(() => expect(api.columns).toHaveBeenCalled());
    fireEvent.keyDown(focus("New record, name"), { key: "x" });
    const input = screen.getByRole("textbox", { name: "New record name" });
    fireEvent.keyDown(input, { key: "Enter" });
    expect(input.getAttribute("aria-invalid")).toBe("true");
    expect((input as HTMLInputElement).value).toBe("x");
    expect(props.onApplyChanges).not.toHaveBeenCalled();
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        { kind: "insert", values: { name: "42" } },
      ]),
    );
  });
});

describe("find in table", () => {
  it.each([
    ["MacIntel", { metaKey: true }],
    ["Win32", { ctrlKey: true }],
  ])(
    "opens in-place Find and highlights without filtering on %s",
    async (platform, modifiers) => {
      vi.spyOn(navigator, "platform", "get").mockReturnValue(
        platform as string,
      );
      grid();
      fireEvent.keyDown(focus("Zeta"), {
        key: "f",
        code: "KeyF",
        ...modifiers,
      });
      const search = screen.getByRole("textbox", {
        name: "Find text in table",
      }) as HTMLInputElement;
      await waitFor(() => expect(document.activeElement).toBe(search));
      fireEvent.change(search, { target: { value: "a" } });
      expect(cell("Zeta").classList.contains("find-match")).toBe(true);
      expect(cell("Alpha").classList.contains("find-match")).toBe(true);
      expect(cell("Beta").classList.contains("find-match")).toBe(true);
      expect(screen.getByText("1 of 3")).toBeTruthy();
      fireEvent.keyDown(search, { key: "Enter" });
      expect(cell("Alpha").classList.contains("find-current")).toBe(true);
      expect(document.activeElement).toBe(search);
      fireEvent.keyDown(search, { key: "Enter", shiftKey: true });
      expect(cell("Zeta").classList.contains("find-current")).toBe(true);
      fireEvent.click(screen.getByRole("button", { name: "Previous match" }));
      expect(cell("Beta").classList.contains("find-current")).toBe(true);
      fireEvent.change(search, { target: { value: "absent" } });
      expect(screen.getByText("No matches")).toBeTruthy();
      expect(
        (
          screen.getByRole("button", {
            name: "Next match",
          }) as HTMLButtonElement
        ).disabled,
      ).toBe(true);
      expect(cell("Zeta")).toBeTruthy();
      fireEvent.keyDown(search, { key: "Escape" });
      expect(
        screen.queryByRole("textbox", { name: "Find text in table" }),
      ).toBeNull();
      expect(cell("Zeta").classList.contains("find-match")).toBe(false);
    },
  );
  it("opens from the toolbar and closes with Done", () => {
    grid();
    fireEvent.click(screen.getByRole("button", { name: "Find in table" }));
    expect(
      screen.getByRole("textbox", { name: "Find text in table" }),
    ).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: "Done" }));
    expect(screen.queryByRole("search", { name: "Find in table" })).toBeNull();
  });
  it("does not take focus away from a cell being edited", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    grid();
    fireEvent.keyDown(focus("Zeta"), { key: "Enter" });
    const input = editor("name");
    fireEvent.keyDown(input, { key: "f", code: "KeyF", metaKey: true });
    expect(document.activeElement).toBe(input);
  });
});

describe("replace in table", () => {
  function replacementSearch(find: string, replacement: string) {
    fireEvent.click(
      screen.getByRole("button", { name: "Find and replace in table" }),
    );
    fireEvent.change(
      screen.getByRole("textbox", { name: "Find text in table" }),
      { target: { value: find } },
    );
    fireEvent.change(screen.getByRole("textbox", { name: "Replace with" }), {
      target: { value: replacement },
    });
  }
  it("replaces the current literal occurrence without interpreting replacement tokens", async () => {
    const { props } = grid({
      result: { ...result, rows: [[1, "a.a.a", null]] },
    });
    replacementSearch("a.", "$&");
    fireEvent.click(screen.getByRole("button", { name: "Replace" }));
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledExactlyOnceWith([
        update(1, { name: "$&a.a" }),
      ]),
    );
  });
  it("replaces all matches on this page while preserving primary keys and NULL", async () => {
    const { props } = grid({
      result: {
        ...result,
        rows: [
          [1, "1.1", null],
          [2, "1.a", "other"],
        ],
      },
    });
    replacementSearch("1", "x");
    fireEvent.click(screen.getByRole("button", { name: "Replace All" }));
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledExactlyOnceWith([
        update(1, { name: "x.x" }),
        update(2, { name: "x.a" }),
      ]),
    );
  });
  it("keeps replacements pending during a transaction", async () => {
    const { props } = grid();
    fireEvent.click(screen.getByRole("button", { name: "Begin Transaction" }));
    replacementSearch("a", "o");
    fireEvent.click(screen.getByRole("button", { name: "Replace All" }));
    expect(props.onApplyChanges).not.toHaveBeenCalled();
    expect(cell("Zeto")).toBeTruthy();
    expect(cell("olpho")).toBeTruthy();
    expect(cell("Beto")).toBeTruthy();
  });
  it("validates every replacement before staging any changes", async () => {
    vi.spyOn(api, "columns").mockResolvedValue([
      { name: "id", data_type: "int", nullable: false },
      { name: "name", data_type: "varchar(50)", nullable: false },
      { name: "note", data_type: "int", nullable: true },
    ]);
    const { props } = grid({
      connectionId: "local",
      result: {
        ...result,
        rows: [
          [1, "item1", 12],
          [2, "item1", 13],
        ],
      },
    });
    await waitFor(() => expect(screen.getByText("varchar(50)")).toBeTruthy());
    replacementSearch("1", "x");
    fireEvent.click(screen.getByRole("button", { name: "Replace All" }));
    expect(props.onApplyChanges).not.toHaveBeenCalled();
    expect(screen.getAllByRole("cell", { name: "item1" })).toHaveLength(2);
    expect(screen.getByText(/Enter a whole number/)).toBeTruthy();
  });
  it("opens with the macOS shortcut and disables writes for read-only results", () => {
    vi.spyOn(navigator, "platform", "get").mockReturnValue("MacIntel");
    grid({ result: { ...result, source: undefined } });
    fireEvent.keyDown(focus("Zeta"), {
      key: "ƒ",
      code: "KeyF",
      metaKey: true,
      altKey: true,
    });
    expect(
      (screen.getByLabelText("Table search mode") as HTMLSelectElement).value,
    ).toBe("replace");
    expect(
      (screen.getByRole("button", { name: "Replace All" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
  });
});
describe("edits stay safe while saves and reloads happen", () => {
  it("refuses a paste while a save is still running instead of losing it", async () => {
    let finish: (value: number) => void = () => {};
    const onApplyChanges = vi.fn(
      () => new Promise<number>((resolve) => (finish = resolve)),
    );
    grid({ onApplyChanges });
    fireEvent.keyDown(focus("Zeta"), { key: "Z" });
    fireEvent.keyDown(editor("name"), { key: "Enter" }); // Leaves the record: saves.
    await waitFor(() => expect(onApplyChanges).toHaveBeenCalledTimes(1));
    readText.mockResolvedValue("a\tb\r\nc\td");
    fireEvent.keyDown(cell("Alpha"), { key: "v", ctrlKey: true });
    await waitFor(() =>
      expect(screen.getByText(/Wait for the current save/)).toBeTruthy(),
    );
    expect(readText).not.toHaveBeenCalled();
    fireEvent.keyDown(cell("Alpha"), {
      key: "d",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.queryByRole("row", { name: "Copy 1" })).toBeNull();
    finish(1);
    await waitFor(() =>
      expect(screen.getByText("1 change saved.")).toBeTruthy(),
    );
    expect(screen.queryByText(/pending$/)).toBeNull();
  });
  it("keeps a pending edit on its record when the result is replaced", async () => {
    const onApplyChanges = vi.fn().mockResolvedValue(1);
    const { rerender } = render(
      <ResultGrid result={result} onApplyChanges={onApplyChanges} />,
    );
    fireEvent.keyDown(focus("Beta"), { key: "B" });
    fireEvent.keyDown(editor("name"), { key: "Tab", shiftKey: true });
    // A reload that returns the rows in another order (or another page) must not
    // move the edit to whichever record now sits at the same position.
    rerender(
      <ResultGrid
        result={{
          ...result,
          rows: [
            [3, "Beta", "third"],
            [9, "New", null],
          ],
        }}
        onApplyChanges={onApplyChanges}
      />,
    );
    expect(screen.getByRole("cell", { name: "B" }).className).toContain(
      "modified",
    );
    expect(cell("New").className).not.toContain("modified");
    fireEvent.keyDown(cell("B"), { key: "s", ctrlKey: true });
    await waitFor(() =>
      expect(onApplyChanges).toHaveBeenCalledWith([update(3, { name: "B" })]),
    );
  });
});
describe("copying a block whose last row is empty", () => {
  it("pastes both rows back instead of repeating the first value", async () => {
    const { props } = grid();
    // The note column holds NULL (Zeta) then "first" (Alpha): copy Alpha/Zeta order.
    fireEvent.keyDown(focus("first"), { key: "ArrowUp", shiftKey: true });
    fireEvent.keyDown(screen.getAllByRole("cell", { name: "NULL" })[0], {
      key: "c",
      ctrlKey: true,
    });
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = writeText.mock.calls.at(-1)![0] as string;
    expect(copied).toBe('""\r\nfirst');
    // Now the reverse block (value then empty) pasted onto two rows of the name column.
    readText.mockResolvedValue("Gamma\r\n" + '""');
    fireEvent.keyDown(focus("Alpha"), { key: "Escape" });
    fireEvent.keyDown(cell("Alpha"), { key: "ArrowDown", shiftKey: true });
    fireEvent.keyDown(cell("Beta"), { key: "v", ctrlKey: true });
    await waitFor(() => expect(props.onApplyChanges).toHaveBeenCalled());
    expect(props.onApplyChanges).toHaveBeenCalledWith([
      update(1, { name: "Gamma" }),
      update(3, { name: "" }),
    ]);
  });
});
describe("select all, copy, paste into the new row", () => {
  it("copies data only, so the field names never become a record", async () => {
    grid();
    fireEvent.keyDown(focus("Alpha"), { key: "a", metaKey: true });
    fireEvent.keyDown(cell("Alpha"), { key: "c", metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    const copied = writeText.mock.calls.at(-1)![0] as string;
    expect(copied).toBe("2\tZeta\t\r\n1\tAlpha\tfirst\r\n3\tBeta\tthird");
    expect(copied).not.toContain("id\tname\tnote");
  });
  it("skips a header row when pasting text that starts with the field names", async () => {
    const { props } = grid();
    readText.mockResolvedValue("name\tnote\r\nCy\tnew\r\nDi\tother\r\n");
    const blank = screen.getByRole("cell", { name: "New record, name" });
    blank.focus();
    fireEvent.keyDown(blank, { key: "v", metaKey: true });
    await waitFor(() =>
      expect(screen.getByText(/header row skipped/)).toBeTruthy(),
    );
    expect(screen.getAllByRole("row", { name: /^Copy / })).toHaveLength(2);
    expect(
      screen.queryByText("name", { selector: '[role="cell"]' }),
    ).toBeNull();
    fireEvent.keyDown(screen.getByRole("cell", { name: "Copy 1, name" }), {
      key: "s",
      metaKey: true,
    });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        { kind: "insert", values: { name: "Cy", note: "new" } },
        { kind: "insert", values: { name: "Di", note: "other" } },
      ]),
    );
  });
});
describe("copy and paste from the row numbers", () => {
  const rowNumber = (n: number) =>
    screen.getByLabelText(`Select record ${n}`) as HTMLElement;
  it("selects a record by its number and copies it with Ctrl/⌘+C", async () => {
    grid();
    fireEvent.mouseDown(rowNumber(2), { button: 0 });
    await waitFor(() =>
      expect(document.activeElement?.closest('[role="row"]')).toBe(
        cell("Alpha").closest('[role="row"]'),
      ),
    );
    expect(screen.getByText("1 selected")).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "c", metaKey: true });
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith("1\tAlpha\tfirst"),
    );
  });
  it("copies several numbered rows and pastes them as new records with new keys", async () => {
    const { props } = grid();
    fireEvent.mouseDown(rowNumber(1), { button: 0 });
    fireEvent.mouseDown(rowNumber(2), { button: 0, shiftKey: true });
    expect(screen.getByText("2 selected")).toBeTruthy();
    fireEvent.keyDown(document.activeElement!, { key: "c", ctrlKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    readText.mockResolvedValue(writeText.mock.calls.at(-1)![0]);
    fireEvent.mouseDown(rowNumber(3), { button: 0 });
    fireEvent.keyDown(document.activeElement!, { key: "v", ctrlKey: true });
    await waitFor(() =>
      expect(screen.getAllByRole("row", { name: /^Copy / })).toHaveLength(2),
    );
    expect(document.querySelectorAll(".modified")).toHaveLength(0);
    // Keys 2 and 1 already exist, so they are cleared for the database to generate.
    expect(screen.getByRole("cell", { name: "Copy 1, id" }).textContent).toBe(
      "",
    );
    fireEvent.keyDown(document.activeElement!, { key: "s", ctrlKey: true });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        { kind: "insert", values: { name: "Zeta", note: "" } },
        { kind: "insert", values: { name: "Alpha", note: "first" } },
      ]),
    );
  });
  it("pastes whole records into the new row from the first column", async () => {
    grid();
    readText.mockResolvedValue("7\tNew\tnote");
    const blankName = screen.getByRole("cell", { name: "New record, name" });
    blankName.focus();
    fireEvent.keyDown(blankName, { key: "v", metaKey: true });
    await waitFor(() =>
      expect(screen.getByRole("cell", { name: "Copy 1, id" }).textContent).toBe(
        "7",
      ),
    );
    expect(screen.getByRole("cell", { name: "Copy 1, note" }).textContent).toBe(
      "note",
    );
  });
});
describe("copy and paste from the checkboxes", () => {
  const checkbox = (n: number) =>
    screen.getByRole("checkbox", { name: `Select row ${n}` });
  it("copies the ticked records with Ctrl/⌘+C right after ticking them", async () => {
    grid();
    fireEvent.click(checkbox(1));
    fireEvent.click(checkbox(3));
    await waitFor(() =>
      expect(document.activeElement?.closest('[role="row"]')).toBe(
        cell("Beta").closest('[role="row"]'),
      ),
    );
    fireEvent.keyDown(document.activeElement!, { key: "c", metaKey: true });
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith("2\tZeta\t\r\n3\tBeta\tthird"),
    );
  });
  it("copies every row after the select-all checkbox", async () => {
    grid();
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all rows on this page" }),
    );
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("role")).toBe("cell"),
    );
    fireEvent.keyDown(document.activeElement!, { key: "c", ctrlKey: true });
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        "2\tZeta\t\r\n1\tAlpha\tfirst\r\n3\tBeta\tthird",
      ),
    );
  });
  it("adds pasted records below instead of overwriting the ticked record", async () => {
    grid();
    readText.mockResolvedValue("9\tPasted\tvalue");
    fireEvent.click(checkbox(2));
    await waitFor(() =>
      expect(document.activeElement?.closest('[role="row"]')).toBe(
        cell("Alpha").closest('[role="row"]'),
      ),
    );
    fireEvent.keyDown(document.activeElement!, { key: "v", ctrlKey: true });
    await waitFor(() =>
      expect(
        screen.getByRole("cell", { name: "Copy 1, name" }).textContent,
      ).toBe("Pasted"),
    );
    expect(cell("Alpha").className).not.toContain("modified");
    // 9 is not an existing key, so it is kept.
    expect(screen.getByRole("cell", { name: "Copy 1, id" }).textContent).toBe(
      "9",
    );
  });
});
describe("select all, copy, paste with a cell clicked earlier (screenshot case)", () => {
  it("adds every copied record below and changes no existing record", async () => {
    grid();
    // A click on a cell in the last row leaves a selection anchor behind.
    const beta = cell("Beta");
    fireEvent.mouseDown(beta, { button: 0 });
    fireEvent.click(beta);
    fireEvent.click(
      screen.getByRole("checkbox", { name: "Select all rows on this page" }),
    );
    fireEvent.keyDown(document.activeElement!, { key: "c", metaKey: true });
    await waitFor(() => expect(writeText).toHaveBeenCalled());
    readText.mockResolvedValue(writeText.mock.calls.at(-1)![0]);
    fireEvent.keyDown(document.activeElement!, { key: "v", metaKey: true });
    await waitFor(() =>
      expect(screen.getAllByRole("row", { name: /^Copy / })).toHaveLength(3),
    );
    expect(document.querySelectorAll(".modified")).toHaveLength(0);
    expect(document.querySelectorAll(".in-range")).toHaveLength(0);
    expect(
      ["Copy 1, name", "Copy 2, name", "Copy 3, name"].map(
        (name) => screen.getByRole("cell", { name }).textContent,
      ),
    ).toEqual(["Zeta", "Alpha", "Beta"]);
    expect(screen.getByText(/3 records pasted below/)).toBeTruthy();
  });
});

it("evaluates Raw Mode functions through the keyed API instead of staging literal text", async () => {
  vi.spyOn(api, "columns").mockResolvedValue([]);
  vi.spyOn(api, "foreignKeys").mockResolvedValue([]);
  const raw = vi.spyOn(api, "updateRawCell").mockResolvedValue(1);
  const onRefresh = vi.fn();
  const { props } = grid({ connectionId: "raw-test", onRefresh });
  fireEvent.click(screen.getByRole("button", { name: "Raw mode" }));
  fireEvent.doubleClick(cell("Zeta"));
  fireEvent.change(editor("name"), { target: { value: "NOW()" } });
  fireEvent.keyDown(editor("name"), { key: "Enter" });
  await waitFor(() =>
    expect(raw).toHaveBeenCalledWith(
      "raw-test",
      result.source,
      { id: 2 },
      "name",
      "NOW()",
    ),
  );
  await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  expect(props.onApplyChanges).not.toHaveBeenCalled();
});

it("allows editing a primary key through Record details with the original identity", async () => {
  const { props } = grid();
  fireEvent.keyDown(focus("2"), { key: "Enter", shiftKey: true });
  const input = screen.getByRole("textbox", { name: "Edit id" });
  expect((input as HTMLTextAreaElement).disabled).toBe(false);
  fireEvent.change(input, { target: { value: "12" } });
  fireEvent.click(screen.getByRole("button", { name: "Save cell" }));
  await waitFor(() =>
    expect(props.onApplyChanges).toHaveBeenCalledWith([
      update(2, { id: "12" }),
    ]),
  );
});

it("opens table design with Command/Ctrl+D without duplicating records or hijacking inputs", () => {
  const onDesign = vi.fn();
  grid({ onDesign });
  fireEvent.keyDown(focus("Alpha"), { key: "d", metaKey: true });
  fireEvent.keyDown(cell("Beta"), { key: "d", ctrlKey: true });
  expect(onDesign).toHaveBeenCalledTimes(2);
  expect(screen.queryByText(/new records pending/)).toBeNull();
  fireEvent.keyDown(cell("Beta"), { key: "Enter" });
  fireEvent.keyDown(editor("name"), { key: "d", metaKey: true });
  expect(onDesign).toHaveBeenCalledTimes(2);
});
