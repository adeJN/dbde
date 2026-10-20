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
import { gridLayoutKey } from "../lib/grid-layout";
import type { QueryResult } from "../types";
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  columns: vi.fn().mockResolvedValue([]),
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
let saved: Map<string, string>;
beforeEach(() => {
  writeText.mockClear();
  readText.mockReset();
  saved = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => saved.get(name) ?? null,
    setItem: (name: string, value: string) => saved.set(name, value),
    removeItem: (name: string) => saved.delete(name),
  });
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText, readText },
  });
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
});
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});
const cell = (name: string) => screen.getByRole("cell", { name });
function focus(name: string) {
  const element = cell(name);
  element.focus();
  return element;
}
const headers = () =>
  screen
    .getAllByRole("columnheader")
    .map((header) => header.getAttribute("aria-label"));
function headerMenu(column: string, item: string) {
  fireEvent.contextMenu(screen.getByRole("columnheader", { name: column }), {
    clientX: 10,
    clientY: 10,
  });
  fireEvent.click(screen.getByRole("menuitem", { name: item }));
}
const key = gridLayoutKey("profile-1", "app_db", "", "customers");
function grid(overrides: Partial<Parameters<typeof ResultGrid>[0]> = {}) {
  const props = {
    result,
    onApplyChanges: vi.fn().mockResolvedValue(1),
    onDelete: vi.fn().mockResolvedValue(undefined),
    driver: "postgres" as const,
    connectionId: "session-1",
    profileId: "profile-1",
    ...overrides,
  };
  return { props, ...render(<ResultGrid {...props} />) };
}

describe("show and hide columns", () => {
  it("hides columns from the Columns popover, which searches, counts and closes with Escape", () => {
    grid();
    const trigger = screen.getByRole("button", { name: "Columns" });
    fireEvent.click(trigger);
    const popover = screen.getByRole("dialog", {
      name: "Show or hide columns",
    });
    expect(trigger.getAttribute("aria-expanded")).toBe("true");
    expect(document.activeElement).toBe(
      within(popover).getByRole("textbox", { name: "Search columns" }),
    );
    fireEvent.click(within(popover).getByRole("checkbox", { name: "name" }));
    expect(headers()).toEqual(["id", "note"]);
    expect(screen.queryByRole("cell", { name: "Alpha" })).toBeNull();
    expect(within(popover).getByText("1 of 3 hidden")).toBeTruthy();
    fireEvent.change(within(popover).getByRole("textbox"), {
      target: { value: "no" },
    });
    expect(within(popover).getAllByRole("checkbox")).toHaveLength(1);
    fireEvent.change(within(popover).getByRole("textbox"), {
      target: { value: "" },
    });
    fireEvent.click(within(popover).getByRole("button", { name: "Hide all" }));
    expect(within(popover).getByText("3 of 3 hidden")).toBeTruthy();
    fireEvent.click(within(popover).getByRole("button", { name: "Show all" }));
    expect(headers()).toEqual(["id", "name", "note"]);
    fireEvent.keyDown(popover, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(document.activeElement).toBe(trigger);
  });
  it("skips hidden columns in keyboard navigation, block copy and Find", async () => {
    grid();
    headerMenu("name", "Hide Column");
    expect(headers()).toEqual(["id", "note"]);
    fireEvent.keyDown(focus("1"), { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(cell("first")));
    fireEvent.keyDown(cell("first"), { key: "Tab" });
    await waitFor(() => expect(document.activeElement).toBe(cell("3")));
    fireEvent.keyDown(cell("3"), { key: "ArrowRight", shiftKey: true });
    fireEvent.keyDown(cell("third"), { key: "ArrowUp", shiftKey: true });
    fireEvent.keyDown(cell("first"), { key: "c", ctrlKey: true });
    await waitFor(() =>
      expect(writeText).toHaveBeenCalledWith("1\tfirst\r\n3\tthird"),
    );
    fireEvent.click(screen.getByRole("button", { name: "Find in table" }));
    fireEvent.change(
      screen.getByRole("textbox", { name: "Find text in table" }),
      {
        target: { value: "Alpha" },
      },
    );
    expect(screen.getByText("No matches")).toBeTruthy();
  });
  it("copies rows and Copy As output with visible columns; UPDATE keeps a hidden key", async () => {
    grid();
    headerMenu("id", "Hide Column");
    const copyAs = (item: string) => {
      fireEvent.contextMenu(cell("Alpha"), { clientX: 10, clientY: 10 });
      fireEvent.click(screen.getByRole("menuitem", { name: "Copy As" }));
      fireEvent.click(screen.getByRole("menuitem", { name: item }));
    };
    copyAs("Insert Statement");
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        `INSERT INTO "customers" ("name", "note") VALUES ('Alpha', 'first');`,
      ),
    );
    copyAs("Update Statement");
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith(
        `UPDATE "customers" SET "name" = 'Alpha', "note" = 'first' WHERE "id" = 1;`,
      ),
    );
    copyAs("Tab Separated Values (Field Name and Data)");
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith("name\tnote\r\nAlpha\tfirst"),
    );
    fireEvent.click(screen.getByRole("checkbox", { name: "Select row 3" }));
    fireEvent.click(screen.getByRole("button", { name: "Copy selected rows" }));
    await waitFor(() =>
      expect(writeText).toHaveBeenLastCalledWith("name\tnote\r\nBeta\tthird"),
    );
  });
  it("saves edits with a hidden primary key and pastes visible records as new rows", async () => {
    const { props } = grid();
    headerMenu("id", "Hide Column");
    fireEvent.keyDown(focus("Alpha"), { key: "Q" });
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Edit name in cell" }),
      { key: "Enter" },
    );
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        { kind: "update", key: { id: 1 }, values: { name: "Q" } },
      ]),
    );
    // Two values are a whole visible record: it becomes a new record below.
    readText.mockResolvedValue("n1\tm1");
    fireEvent.keyDown(focus("Beta"), { key: "v", ctrlKey: true });
    await waitFor(() =>
      expect(
        screen.getByRole("cell", { name: "Copy 1, note" }).textContent,
      ).toBe("m1"),
    );
    expect(screen.queryByRole("cell", { name: "Copy 1, id" })).toBeNull();
    fireEvent.keyDown(document.activeElement!, { key: "s", ctrlKey: true });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenLastCalledWith([
        { kind: "insert", values: { name: "n1", note: "m1" } },
      ]),
    );
  });
  it("shows only visible columns in the new-record row", () => {
    grid();
    headerMenu("note", "Hide Column");
    expect(
      screen.getByRole("cell", { name: "New record, name" }).dataset.gridCol,
    ).toBe("1");
    expect(screen.queryByRole("cell", { name: "New record, note" })).toBeNull();
  });
  it("hides from the cell context menu and remembers the layout per profile table", () => {
    const first = grid();
    fireEvent.contextMenu(cell("first"), { clientX: 10, clientY: 10 });
    fireEvent.click(screen.getByRole("menuitem", { name: "Hide Column" }));
    expect(headers()).toEqual(["id", "name"]);
    expect(JSON.parse(saved.get(key)!)).toEqual({
      columns: ["id", "name", "note"],
      hidden: ["note"],
      frozen: [],
    });
    first.unmount();
    // Another session of the same profile shows the same layout.
    grid({ connectionId: "session-2" });
    expect(headers()).toEqual(["id", "name"]);
    expect(
      screen.getByRole("button", { name: "Columns" }).textContent,
    ).toContain("1");
    cleanup();
    grid({ profileId: "profile-2" });
    expect(headers()).toEqual(["id", "name", "note"]);
    cleanup();
    // The table's columns changed: the saved layout no longer applies.
    grid({
      result: { ...result, columns: ["id", "name", "note", "extra"], rows: [] },
    });
    expect(headers()).toEqual(["id", "name", "note", "extra"]);
  });
  it("defaults the export dialog to the visible columns", () => {
    grid();
    headerMenu("note", "Hide Column");
    fireEvent.click(screen.getByRole("button", { name: /Export/ }));
    const dialog = screen.getByRole("dialog");
    const box = (name: string) =>
      within(dialog).getByRole("checkbox", { name }) as HTMLInputElement;
    expect(box("name").checked).toBe(true);
    expect(box("note").checked).toBe(false);
  });
});

describe("freeze columns", () => {
  it("moves frozen columns first with sticky offsets and navigates in displayed order", async () => {
    const { props } = grid();
    headerMenu("note", "Freeze Column");
    expect(headers()).toEqual(["note", "id", "name"]);
    const header = screen.getByRole("columnheader", {
      name: "note",
    }).parentElement!;
    expect(header.className).toContain("frozen-cell");
    expect(header.className).toContain("frozen-last");
    expect(header.style.left).toBe("82px");
    expect(cell("first").className).toContain("frozen-cell");
    expect(cell("first").style.left).toBe("82px");
    expect(cell("Alpha").className).not.toContain("frozen-cell");
    expect(document.querySelector(".grid-scroll")!.className).toContain(
      "has-frozen",
    );
    const blank = screen.getByRole("cell", { name: "New record, note" });
    expect(blank.dataset.gridCol).toBe("0");
    expect(blank.className).toContain("frozen-cell");
    fireEvent.keyDown(focus("first"), { key: "ArrowRight" });
    await waitFor(() => expect(document.activeElement).toBe(cell("1")));
    fireEvent.keyDown(cell("1"), { key: "Home" });
    await waitFor(() => expect(document.activeElement).toBe(cell("first")));
    // Frozen columns stay editable (unlike Navicat).
    fireEvent.keyDown(cell("first"), { key: "x" });
    const editor = screen.getByRole("textbox", { name: "Edit note in cell" });
    fireEvent.keyDown(editor, { key: "Enter" });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        { kind: "update", key: { id: 1 }, values: { note: "x" } },
      ]),
    );
    expect(JSON.parse(saved.get(key)!).frozen).toEqual(["note"]);
    headerMenu("id", "Freeze Column");
    expect(headers()).toEqual(["note", "id", "name"]);
    expect(
      screen.getByRole("columnheader", { name: "id" }).parentElement!.style
        .left,
    ).not.toBe("82px");
    headerMenu("name", "Unfreeze All");
    expect(headers()).toEqual(["id", "name", "note"]);
    expect(document.querySelector(".frozen-cell")).toBeNull();
    expect(saved.has(key)).toBe(false);
  });
});
