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
import type { ColumnInfo, ForeignKeyInfo, QueryResult } from "../types";

const info: ColumnInfo[] = [
  { name: "id", data_type: "integer", nullable: false },
  {
    name: "size",
    data_type: "mood",
    nullable: true,
    enum_values: ["s", "m", "l"],
  },
  {
    name: "tags",
    data_type: "set('red','green','blue')",
    nullable: true,
    set_values: ["red", "green", "blue"],
  },
  { name: "active", data_type: "boolean", nullable: false, is_boolean: true },
  { name: "born", data_type: "date", nullable: true },
  { name: "seen_at", data_type: "timestamp(6) with time zone", nullable: true },
  { name: "tenant", data_type: "integer", nullable: true },
  { name: "code", data_type: "text", nullable: true },
];
const accountKey: ForeignKeyInfo = {
  name: "fk_account",
  columns: ["tenant", "code"],
  referenced_table: { name: "accounts", schema: "public", kind: "table" },
  referenced_columns: ["tenant_id", "code"],
};
vi.mock("../lib/api", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/api")>()),
  columns: vi.fn(),
  foreignKeys: vi.fn(),
  viewTable: vi.fn(),
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
  columns: info.map((column) => column.name),
  rows: [
    [
      1,
      "m",
      "red",
      true,
      "2026-10-18",
      "2026-10-18 04:34:51.799544+07",
      1,
      "A",
    ],
    [2, "s", "", false, null, null, 7, "Q"],
  ],
  execution_ms: 1,
  affected_rows: 0,
  truncated: false,
  source: {
    database: "app_db",
    table: { name: "orders", schema: "public", kind: "table" },
    primary_keys: ["id"],
  },
};
const accounts: QueryResult = {
  columns: ["tenant_id", "code", "label"],
  rows: [
    [1, "A", "Alpha"],
    [2, "Z", "Zulu"],
  ],
  pagination: { page: 1, page_size: 1000, total_rows: 2 },
  execution_ms: 1,
  affected_rows: 0,
  truncated: false,
};
beforeEach(() => {
  vi.mocked(api.columns).mockResolvedValue(info);
  vi.mocked(api.foreignKeys).mockResolvedValue([accountKey]);
  vi.mocked(api.viewTable).mockResolvedValue(accounts);
  vi.spyOn(document, "hasFocus").mockReturnValue(true);
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => saved.get(name) ?? null,
    setItem: (name: string, value: string) => saved.set(name, value),
    removeItem: (name: string) => saved.delete(name),
  });
});
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  vi.unstubAllGlobals();
});
const cell = (name: string) => screen.getByRole("cell", { name });
const update = (id: number, values: Record<string, string | null>) => ({
  kind: "update",
  key: { id },
  values,
});
async function grid(overrides: Partial<Parameters<typeof ResultGrid>[0]> = {}) {
  const props = {
    result,
    onApplyChanges: vi.fn().mockResolvedValue(1),
    onDelete: vi.fn().mockResolvedValue(undefined),
    driver: "postgres" as const,
    connectionId: "session-1",
    ...overrides,
  };
  const view = render(<ResultGrid {...props} />);
  // Metadata arrives asynchronously; the type row shows once it has.
  await screen.findByText("mood");
  await waitFor(() => expect(api.foreignKeys).toHaveBeenCalled());
  return { props, ...view };
}
const picker = (column: string) =>
  screen.getByRole("dialog", { name: `${column} editor` });
function openWithAlt(element: HTMLElement) {
  element.focus();
  fireEvent.keyDown(element, { key: "ArrowDown", altKey: true });
}

describe("special editors in the grid", () => {
  it("ENUM: Alt+↓ opens the list; Enter picks, moves down and saves on record leave", async () => {
    const { props } = await grid();
    openWithAlt(cell("m"));
    const list = within(picker("size")).getByRole("listbox");
    expect(
      within(list)
        .getAllByRole("option")
        .map((option) => option.textContent),
    ).toEqual(["s", "m", "l", "NULL"]);
    expect(
      within(list).getByRole("option", { selected: true }).textContent,
    ).toBe("m");
    fireEvent.keyDown(list, { key: "ArrowDown" });
    fireEvent.keyDown(list, { key: "Enter" });
    expect(screen.queryByRole("dialog", { name: "size editor" })).toBeNull();
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(1, { size: "l" }),
      ]),
    );
  });
  it("SET: the checklist joins members in definition order and stays staged", async () => {
    const { props } = await grid();
    fireEvent.keyDown(screen.getAllByRole("cell", { name: "red" })[0], {
      key: "Enter",
    });
    fireEvent.click(screen.getByRole("button", { name: "Open tags editor" }));
    const dialog = picker("tags");
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "blue" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "green" }));
    fireEvent.click(within(dialog).getByRole("checkbox", { name: "red" }));
    fireEvent.click(within(dialog).getByRole("button", { name: "OK" }));
    expect(cell("green,blue").className).toContain("modified");
    expect(screen.getByText("1 change pending")).toBeTruthy();
    expect(props.onApplyChanges).not.toHaveBeenCalled();
    await waitFor(() =>
      expect(document.activeElement).toBe(cell("green,blue")),
    );
  });
  it("boolean: true/false only for NOT NULL columns; a click stages the driver literal", async () => {
    const { props } = await grid();
    openWithAlt(cell("true"));
    const options = within(picker("active")).getAllByRole("option");
    expect(options.map((option) => option.textContent)).toEqual([
      "true",
      "false",
    ]);
    fireEvent.click(options[1]);
    expect(screen.getAllByRole("cell", { name: "false" })).toHaveLength(2);
    expect(screen.getByText("1 change pending")).toBeTruthy();
    expect(props.onApplyChanges).not.toHaveBeenCalled();
  });
  it("DATE: the picker writes YYYY-MM-DD; Escape closes it, then cancels the edit", async () => {
    await grid();
    fireEvent.keyDown(cell("2026-10-18"), { key: "Enter" });
    const input = screen.getByRole("textbox", {
      name: "Edit born in cell",
    }) as HTMLInputElement;
    fireEvent.click(screen.getByRole("button", { name: "Open born editor" }));
    fireEvent.keyDown(within(picker("born")).getByLabelText("Date"), {
      key: "Escape",
    });
    expect(screen.queryByRole("dialog", { name: "born editor" })).toBeNull();
    expect(document.activeElement).toBe(input);
    // Typing still works next to the picker.
    fireEvent.change(input, { target: { value: "2026-10-1" } });
    fireEvent.keyDown(input, { key: "ArrowDown", altKey: true });
    const date = within(picker("born")).getByLabelText(
      "Date",
    ) as HTMLInputElement;
    fireEvent.change(date, { target: { value: "2027-03-04" } });
    fireEvent.click(within(picker("born")).getByRole("button", { name: "OK" }));
    expect(cell("2027-03-04").className).toContain("modified");
    fireEvent.keyDown(cell("2027-03-04"), { key: "Enter" });
    fireEvent.keyDown(
      screen.getByRole("textbox", { name: "Edit born in cell" }),
      { key: "Escape" },
    );
    await waitFor(() =>
      expect(document.activeElement).toBe(cell("2027-03-04")),
    );
  });
  it("TIMESTAMPTZ: keeps the stored offset and fractional seconds and says which zone applies", async () => {
    const { props } = await grid();
    openWithAlt(cell("2026-10-18 04:34:51.799544+07"));
    const dialog = picker("seen_at");
    expect(within(dialog).getByText(/Offset \+07 kept/)).toBeTruthy();
    expect(
      (within(dialog).getByLabelText("Fractional seconds") as HTMLInputElement)
        .value,
    ).toBe("799544");
    expect(
      (within(dialog).getByLabelText("UTC offset") as HTMLInputElement).value,
    ).toBe("+07");
    fireEvent.change(within(dialog).getByLabelText("Date and time"), {
      target: { value: "2026-12-31T23:59:58" },
    });
    fireEvent.keyDown(within(dialog).getByLabelText("Date and time"), {
      key: "Enter",
    });
    // Enter picks and moves down to the next record, which saves this one.
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(1, { seen_at: "2026-12-31 23:59:58.799544+07" }),
      ]),
    );
  });
  it("NULL in the picker sets NULL; binary and primary keys get no picker", async () => {
    await grid();
    openWithAlt(cell("2026-10-18"));
    fireEvent.click(
      within(picker("born")).getByRole("button", { name: "NULL" }),
    );
    expect(
      screen.getAllByRole("cell", { name: "NULL" }).length,
    ).toBeGreaterThan(1);
    openWithAlt(screen.getAllByRole("cell", { name: "1" })[0]);
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("special editors in Form view", () => {
  it("uses a dropdown for ENUM/boolean, a checklist for SET and a picker for dates", async () => {
    const { props } = await grid();
    fireEvent.click(screen.getByRole("button", { name: "Form view" }));
    const size = screen.getByRole("combobox", {
      name: "size",
    }) as HTMLSelectElement;
    expect(size.selectedOptions[0].textContent).toBe("m");
    fireEvent.change(size, { target: { value: "2" } });
    const active = screen.getByRole("combobox", {
      name: "active",
    }) as HTMLSelectElement;
    expect(active.selectedOptions[0].textContent).toBe("true");
    fireEvent.change(active, { target: { value: "1" } });
    const tags = screen.getByRole("group", { name: "tags" });
    fireEvent.click(within(tags).getByRole("checkbox", { name: "blue" }));
    fireEvent.click(screen.getByRole("button", { name: "Open born editor" }));
    fireEvent.change(within(picker("born")).getByLabelText("Date"), {
      target: { value: "2025-05-06" },
    });
    fireEvent.click(within(picker("born")).getByRole("button", { name: "OK" }));
    expect(
      (screen.getByRole("textbox", { name: "born" }) as HTMLInputElement).value,
    ).toBe("2025-05-06");
    expect(props.onApplyChanges).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Next record" }));
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(1, {
          size: "l",
          active: "false",
          tags: "red,blue",
          born: "2025-05-06",
        }),
      ]),
    );
  });
});

describe("special editors in new-record rows", () => {
  it("picks ENUM and date values for a draft and saves them with Ctrl/⌘+Enter", async () => {
    const { props } = await grid();
    openWithAlt(cell("New record, size"));
    const list = within(picker("size")).getByRole("listbox");
    fireEvent.keyDown(list, { key: "End" });
    fireEvent.keyDown(list, { key: "ArrowUp" });
    fireEvent.keyDown(list, { key: "Tab" });
    // Tab picks and moves right, onto the SET column of the same draft.
    await waitFor(() =>
      expect(document.activeElement?.getAttribute("aria-label")).toBe(
        "Draft 1, tags",
      ),
    );
    openWithAlt(cell("Draft 1, born"));
    fireEvent.click(
      within(picker("born")).getByRole("button", { name: "Today" }),
    );
    const today = new Date();
    const pad = (n: number) => String(n).padStart(2, "0");
    const text = `${today.getFullYear()}-${pad(today.getMonth() + 1)}-${pad(today.getDate())}`;
    expect(cell("Draft 1, born").textContent).toBe(text);
    expect(props.onApplyChanges).not.toHaveBeenCalled();
    fireEvent.keyDown(cell("Draft 1, born"), { key: "Enter", ctrlKey: true });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        { kind: "insert", values: { size: "l", born: text } },
      ]),
    );
  });
});

describe("foreign key data selection", () => {
  it("searches on the server, sorts, and sets every column of a composite key", async () => {
    const { props } = await grid();
    // `code` has no special editor, so Alt+↓ opens the selection directly.
    openWithAlt(cell("A"));
    const dialog = await screen.findByRole("dialog", {
      name: "Select from accounts",
    });
    await within(dialog).findByText("Alpha");
    expect(api.viewTable).toHaveBeenLastCalledWith(
      "session-1",
      "app_db",
      accountKey.referenced_table,
      1,
      1000,
      [],
      undefined,
    );
    // The current key is highlighted.
    expect(
      within(dialog)
        .getByText("Alpha")
        .closest("tr")
        ?.getAttribute("aria-selected"),
    ).toBe("true");
    fireEvent.change(within(dialog).getByRole("searchbox"), {
      target: { value: "zu" },
    });
    await waitFor(() =>
      expect(api.viewTable).toHaveBeenLastCalledWith(
        "session-1",
        "app_db",
        accountKey.referenced_table,
        1,
        1000,
        [
          {
            join: "and",
            column: "tenant_id",
            operator: "contains",
            value: "zu",
          },
          { join: "or", column: "code", operator: "contains", value: "zu" },
          { join: "or", column: "label", operator: "contains", value: "zu" },
        ],
        undefined,
      ),
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "label" }));
    await waitFor(() =>
      expect(vi.mocked(api.viewTable).mock.lastCall?.[6]).toEqual({
        column: "label",
        direction: "asc",
      }),
    );
    fireEvent.doubleClick(await within(dialog).findByText("Zulu"));
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(cell("Z").className).toContain("modified");
    expect(screen.getByText("1 change pending")).toBeTruthy();
    expect(props.onApplyChanges).not.toHaveBeenCalled();
    await waitFor(() => expect(document.activeElement).toBe(cell("Z")));
    fireEvent.keyDown(cell("Z"), { key: "ArrowDown" });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(1, { tenant: "2", code: "Z" }),
      ]),
    );
  });
  it("offers the selection from the cell picker and in new records and Form view", async () => {
    const { props } = await grid();
    fireEvent.keyDown(cell("New record, code"), { key: "Enter" });
    fireEvent.click(
      screen.getByRole("button", { name: "Select from accounts…" }),
    );
    const dialog = await screen.findByRole("dialog", {
      name: "Select from accounts",
    });
    await within(dialog).findByText("Alpha");
    fireEvent.keyDown(within(dialog).getByRole("grid"), { key: "ArrowDown" });
    fireEvent.keyDown(within(dialog).getByRole("grid"), { key: "Enter" });
    expect(cell("Draft 1, tenant").textContent).toBe("2");
    expect(cell("Draft 1, code").textContent).toBe("Z");
    expect(props.onApplyChanges).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Form view" }));
    fireEvent.click(screen.getByRole("button", { name: "First record" }));
    // Leaving the new record saves it with every column of the key.
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        { kind: "insert", values: { tenant: "2", code: "Z" } },
      ]),
    );
    fireEvent.click(
      (
        await screen.findAllByRole("button", { name: "Select from accounts…" })
      )[0],
    );
    const again = await screen.findByRole("dialog", {
      name: "Select from accounts",
    });
    // Escape closes the selection without changing anything.
    fireEvent.keyDown(again, { key: "Escape" });
    expect(screen.queryByRole("dialog")).toBeNull();
    expect(screen.queryByText("Unsaved")).toBeNull();
  });
  it("sets hidden key columns too and works on frozen columns", async () => {
    localStorage.setItem(
      `dbde.grid-layout:${JSON.stringify(["session-1", "app_db", "public", "orders"])}`,
      JSON.stringify({
        columns: result.columns,
        hidden: ["tenant"],
        frozen: ["code"],
      }),
    );
    const { props } = await grid();
    expect(screen.queryByRole("columnheader", { name: /^tenant/ })).toBeNull();
    // The frozen key column comes first; Alt+↓ there opens the selection.
    openWithAlt(cell("A"));
    const dialog = await screen.findByRole("dialog", {
      name: "Select from accounts",
    });
    fireEvent.doubleClick(await within(dialog).findByText("Zulu"));
    fireEvent.keyDown(cell("Z"), { key: "ArrowDown" });
    await waitFor(() =>
      expect(props.onApplyChanges).toHaveBeenCalledWith([
        update(1, { tenant: "2", code: "Z" }),
      ]),
    );
  });
});
