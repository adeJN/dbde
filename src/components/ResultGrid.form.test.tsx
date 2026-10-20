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
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  columns: vi.fn().mockResolvedValue([
    { name: "id", data_type: "integer", nullable: false },
    { name: "name", data_type: "varchar(40)", nullable: true },
    { name: "note", data_type: "varchar(200)", nullable: true },
  ]),
}));
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
    [1, "Alpha", "first\nsecond line"],
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
beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => saved.get(name) ?? null,
    setItem: (name: string, value: string) => saved.set(name, value),
    removeItem: (name: string) => saved.delete(name),
  });
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const update = (id: number, values: Record<string, string | null>) => ({
  kind: "update",
  key: { id },
  values,
});
const field = (name: string) =>
  screen.getByRole("textbox", { name }) as
    HTMLInputElement | HTMLTextAreaElement;
const position = () =>
  within(screen.getByRole("toolbar", { name: "Record navigation" })).getByRole(
    "status",
  ).textContent;
const button = (name: string) =>
  screen.getByRole("button", { name }) as HTMLButtonElement;
function grid(overrides: Partial<Parameters<typeof ResultGrid>[0]> = {}) {
  const props = {
    result,
    onApplyChanges: vi.fn().mockResolvedValue(1),
    onDelete: vi.fn().mockResolvedValue(undefined),
    driver: "postgres" as const,
    connectionId: "session-1",
    ...overrides,
  };
  const view = render(<ResultGrid {...props} />);
  fireEvent.click(screen.getByRole("button", { name: "Form view" }));
  return { props, ...view };
}

describe("form view", () => {
  it("shows one record with types and moves with the buttons and Page Up/Down", async () => {
    grid();
    expect(screen.getByRole("region", { name: "Form view" })).toBeTruthy();
    expect(button("Form view").getAttribute("aria-pressed")).toBe("true");
    expect(position()).toBe("Record 1 of 3 on this page");
    expect(field("name").value).toBe("Zeta");
    await waitFor(() =>
      expect(field("id").getAttribute("aria-describedby")).toBeTruthy(),
    );
    expect(screen.getByText("integer")).toBeTruthy();
    expect(button("First record").disabled).toBe(true);
    fireEvent.click(button("Next record"));
    expect(position()).toBe("Record 2 of 3 on this page");
    // Multi-line values get a textarea.
    expect(field("note").tagName).toBe("TEXTAREA");
    expect(field("note").value).toBe("first\nsecond line");
    fireEvent.keyDown(field("name"), { key: "PageDown" });
    expect(position()).toBe("Record 3 of 3 on this page");
    expect(button("Next record").disabled).toBe(true);
    fireEvent.keyDown(field("name"), { key: "PageUp", ctrlKey: true });
    expect(position()).toBe("Record 1 of 3 on this page");
    fireEvent.click(button("Last record"));
    expect(field("name").value).toBe("Beta");
  });
  it("stages edits and saves them when another record is shown", async () => {
    const { props } = grid();
    fireEvent.change(field("name"), { target: { value: "Zed" } });
    expect(screen.getByText("Unsaved")).toBeTruthy();
    expect(screen.getByText("1 change pending")).toBeTruthy();
    expect(props.onApplyChanges).not.toHaveBeenCalled();
    fireEvent.click(button("Next record"));
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(2, { name: "Zed" }),
      ]),
    );
  });
  it("toggles NULL per field and saves with Ctrl/⌘+S; primary keys are editable", async () => {
    const { props } = grid();
    expect(field("id").readOnly).toBe(false);
    const nullBox = screen.getByRole("checkbox", {
      name: "note is NULL",
    }) as HTMLInputElement;
    expect(nullBox.checked).toBe(true);
    expect(field("note").placeholder).toBe("NULL");
    fireEvent.click(nullBox);
    expect(nullBox.checked).toBe(false);
    fireEvent.change(field("note"), { target: { value: "hello" } });
    fireEvent.click(button("Next record"));
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(2, { note: "hello" }),
      ]),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "name is NULL" }));
    fireEvent.keyDown(field("name"), { key: "s", ctrlKey: true });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenLastCalledWith([
        update(1, { name: null }),
      ]),
    );
  });
  it("discards the record's changes with Escape", () => {
    const { props } = grid();
    fireEvent.change(field("name"), { target: { value: "Changed" } });
    fireEvent.keyDown(field("name"), { key: "Escape" });
    expect(field("name").value).toBe("Zeta");
    fireEvent.click(button("Next record"));
    expect(props.onApplyChanges).not.toHaveBeenCalled();
  });
  it("keeps edits pending inside a transaction", () => {
    const render = grid();
    fireEvent.click(screen.getByRole("button", { name: /Begin Transaction/ }));
    fireEvent.change(field("name"), { target: { value: "Zed" } });
    fireEvent.click(button("Next record"));
    expect(render.props.onApplyChanges).not.toHaveBeenCalled();
    expect(screen.getByText("1 change pending")).toBeTruthy();
  });
  it("adds a record through the draft row and saves it on leaving", async () => {
    const { props } = grid();
    fireEvent.click(button("Add record in form"));
    expect(position()).toBe("New record");
    expect(field("name").placeholder).toBe("(default)");
    fireEvent.change(field("name"), { target: { value: "Neo" } });
    expect(screen.getByText("Unsaved")).toBeTruthy();
    fireEvent.click(button("First record"));
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        { kind: "insert", values: { name: "Neo" } },
      ]),
    );
  });
  it("deletes the current record after the usual confirmation", async () => {
    const { props } = grid();
    fireEvent.click(button("Next record"));
    fireEvent.click(button("Delete record"));
    const dialog = screen.getByRole("dialog");
    expect(within(dialog).getByText("id: 1")).toBeTruthy();
    fireEvent.click(
      within(dialog).getByRole("button", { name: "Delete 1 row" }),
    );
    await waitFor(() =>
      expect(props.onDelete).toHaveBeenCalledWith([
        [1, "Alpha", "first\nsecond line"],
      ]),
    );
  });
  it("respects hidden columns and returns to the active record in the grid", async () => {
    grid();
    fireEvent.click(button("Grid view"));
    fireEvent.contextMenu(screen.getByRole("columnheader", { name: "note" }), {
      clientX: 10,
      clientY: 10,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide Column" }));
    fireEvent.click(button("Form view"));
    expect(screen.queryByRole("textbox", { name: "note" })).toBeNull();
    fireEvent.click(button("Last record"));
    fireEvent.click(button("Grid view"));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("cell", { name: "3" }),
      ),
    );
    expect(
      screen.getByRole("cell", { name: "3" }).closest('[role="row"]')!
        .className,
    ).toContain("active-row");
  });
  it("toggles between Grid and Form view with Ctrl+Shift+F", async () => {
    grid();
    fireEvent.keyDown(field("name"), {
      key: "F",
      code: "KeyF",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.queryByRole("region", { name: "Form view" })).toBeNull();
    const zeta = screen.getByRole("cell", { name: "Zeta" });
    zeta.focus();
    fireEvent.keyDown(zeta, {
      key: "F",
      code: "KeyF",
      ctrlKey: true,
      shiftKey: true,
    });
    expect(screen.getByRole("region", { name: "Form view" })).toBeTruthy();
    await waitFor(() => expect(document.activeElement).toBe(field("id")));
  });
  it("shows binary values read-only", () => {
    grid({
      result: {
        ...result,
        columns: ["id", "data"],
        rows: [[1, { hex: "00ff" }]],
      },
    });
    expect(field("data").readOnly).toBe(true);
    expect(field("data").title).toContain("Binary");
  });
});
