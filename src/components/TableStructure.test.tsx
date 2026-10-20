// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  within,
  waitFor,
  act,
} from "@testing-library/react";
import TableStructure from "./TableStructure";
import type { TableStructureRequest } from "./TableStructure";
const api = vi.hoisted(() => ({
  columns: vi.fn(),
  listIndexes: vi.fn(),
  tableDdl: vi.fn(),
  renameTableFields: vi.fn(),
  alterTableFields: vi.fn(),
}));
const clipboard = vi.hoisted(() => vi.fn());
const tableDetails = vi.hoisted(() => vi.fn());
vi.mock("../lib/api", () => api);
vi.mock("../lib/table-structure", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/table-structure")>()),
  loadTableDetails: tableDetails,
}));
vi.mock("../lib/clipboard", () => ({ writeClipboard: clipboard }));
const request: TableStructureRequest = {
  session: {
    id: "local",
    config: {
      id: "local",
      name: "Local MySQL",
      driver: "mysql",
      host: "localhost",
      port: 3306,
      username: "root",
      database: "app",
      file_path: "",
      ssl_mode: "disable",
    },
  },
  database: "app",
  table: { name: "customers", schema: "app", kind: "table" },
};
beforeEach(() => {
  vi.clearAllMocks();
  api.columns.mockResolvedValue([
    { name: "id", data_type: "int(11)", nullable: false },
    { name: "name", data_type: "varchar(255)", nullable: true },
  ]);
  api.listIndexes.mockResolvedValue([
    { name: "PRIMARY", columns: ["id"], unique: true, primary: true },
  ]);
  api.tableDdl.mockResolvedValue(
    "CREATE TABLE `customers` (`id` int PRIMARY KEY, `name` varchar(255));",
  );
  clipboard.mockResolvedValue(undefined);
  api.renameTableFields.mockResolvedValue(undefined);
  api.alterTableFields.mockResolvedValue(
    "ALTER TABLE `app`.`customers` CHANGE COLUMN `name` `name` varchar(128);",
  );
  tableDetails.mockResolvedValue({
    fields: [
      {
        name: "id",
        type: "int",
        length: "11",
        decimals: "",
        default_value: null,
        charset: null,
        collation: null,
        comment: "Identifier",
        generated: false,
        stored: false,
        expression: "",
        primary: true,
        auto_increment: true,
      },
      {
        name: "name",
        type: "varchar",
        length: "255",
        decimals: "",
        default_value: "Guest",
        charset: "utf8mb4",
        collation: "utf8mb4_general_ci",
        comment: "Display name",
        generated: false,
        stored: false,
        expression: "",
        primary: false,
        auto_increment: false,
      },
    ],
    foreignKeys: [
      {
        name: "customer_account",
        definition: "(account_id) → app.accounts (id)",
      },
    ],
    triggers: [
      {
        name: "before_customer",
        timing: "BEFORE",
        event: "INSERT",
        definition: "SET NEW.name = TRIM(NEW.name)",
      },
    ],
    checks: [{ name: "name_required", definition: "LENGTH(name) > 0" }],
    options: { engine: "InnoDB", collation: "utf8mb4_general_ci" },
    comment: "Customer records",
    unavailable: [],
  });
});
afterEach(cleanup);

it("loads actual structure and selects fields by mouse and keyboard", async () => {
  render(
    <TableStructure request={request} onClose={vi.fn()} onEdit={vi.fn()} />,
  );
  expect(screen.getByRole("status").textContent).toContain(
    "Loading table structure",
  );
  const table = await screen.findByRole("table", { name: "Table fields" });
  expect(api.columns).toHaveBeenCalledWith("local", request.table, "app");
  const rows = within(table).getAllByRole("row").slice(1);
  const inspector = screen.getByRole("complementary", {
    name: "Selected field properties",
  });
  expect(within(inspector).getByRole("heading", { name: "id" })).toBeTruthy();
  fireEvent.click(rows[1]);
  expect(within(inspector).getByRole("heading", { name: "name" })).toBeTruthy();
  fireEvent.keyDown(rows[1], { key: "ArrowUp" });
  expect(document.activeElement).toBe(rows[0]);
  expect(within(inspector).getByRole("heading", { name: "id" })).toBeTruthy();
  fireEvent.change(
    screen.getByRole("textbox", { name: "Search structure fields" }),
    { target: { value: "varchar" } },
  );
  expect(within(table).getAllByRole("row")).toHaveLength(2);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Search structure fields" }),
    { target: { value: "missing" } },
  );
  expect(screen.getByText("No matching fields")).toBeTruthy();
});

it("matches the reference sections, field columns and bottom properties with database values", async () => {
  render(
    <TableStructure request={request} onClose={vi.fn()} onEdit={vi.fn()} />,
  );
  const table = await screen.findByRole("table", { name: "Table fields" });
  expect(
    screen
      .getAllByRole("tab")
      .map((tab) => tab.textContent?.replace(/\d+$/, "")),
  ).toEqual([
    "Fields",
    "Indexes",
    "Foreign Keys",
    "Triggers",
    "Checks",
    "Options",
    "Comment",
    "SQL Preview",
  ]);
  expect(
    within(table)
      .getAllByRole("columnheader")
      .map((header) => header.textContent),
  ).toEqual([
    "#",
    "Name",
    "Type",
    "Length",
    "Decimals",
    "Not Null",
    "Virtual",
    "Key",
    "Comment",
  ]);
  fireEvent.focus(screen.getByRole("textbox", { name: "Field name name" }));
  expect(
    (
      screen.getByRole("textbox", {
        name: "Field default value",
      }) as HTMLInputElement
    ).value,
  ).toBe("Guest");
  expect(
    (
      screen.getByRole("combobox", {
        name: "Field character set",
      }) as HTMLInputElement
    ).value,
  ).toBe("utf8mb4");
  expect(
    (
      screen.getByRole("combobox", {
        name: "Field collation",
      }) as HTMLInputElement
    ).value,
  ).toBe("utf8mb4_general_ci");
  expect(
    (screen.getByRole("textbox", { name: "name comment" }) as HTMLInputElement)
      .value,
  ).toBe("Display name");
  fireEvent.click(screen.getByRole("tab", { name: "Foreign Keys" }));
  expect(screen.getByText("customer_account")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Triggers" }));
  expect(screen.getByText("BEFORE INSERT")).toBeTruthy();
  expect(screen.getByText("SET NEW.name = TRIM(NEW.name)")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Checks" }));
  expect(screen.getByText("LENGTH(name) > 0")).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Options" }));
  expect(
    (
      screen.getByRole("textbox", {
        name: "Table option engine",
      }) as HTMLInputElement
    ).value,
  ).toBe("InnoDB");
  fireEvent.click(screen.getByRole("tab", { name: "Comment" }));
  expect(
    (screen.getByRole("textbox", { name: "Table comment" }) as HTMLInputElement)
      .value,
  ).toBe("Customer records");
});

it("stages field names and saves once with the keyboard while protecting a running save", async () => {
  const onSaved = vi.fn(),
    onClose = vi.fn();
  let finish!: () => void;
  api.renameTableFields.mockImplementationOnce(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  render(
    <TableStructure
      request={request}
      onClose={onClose}
      onEdit={vi.fn()}
      onSaved={onSaved}
    />,
  );
  await screen.findByRole("table", { name: "Table fields" });
  fireEvent.change(screen.getByRole("textbox", { name: "Field name name" }), {
    target: { value: "full name" },
  });
  expect(api.renameTableFields).not.toHaveBeenCalled();
  expect(
    (screen.getByRole("button", { name: "SQL Editor" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "s", metaKey: true });
  await waitFor(() => expect(api.renameTableFields).toHaveBeenCalledOnce());
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "s", metaKey: true });
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(onClose).not.toHaveBeenCalled();
  expect(api.renameTableFields).toHaveBeenCalledWith(
    "local",
    "app",
    request.table,
    [{ from: "name", to: "full name" }],
  );
  api.columns.mockResolvedValue([
    { name: "id", data_type: "int(11)", nullable: false },
    { name: "full name", data_type: "varchar(255)", nullable: true },
  ]);
  tableDetails.mockResolvedValue({
    fields: [],
    indexes: [],
    foreignKeys: [],
    triggers: [],
    checks: [],
    options: {},
    comment: "",
    unavailable: [],
  });
  await act(async () => finish());
  await screen.findByRole("textbox", { name: "Field full name name" });
  expect(onSaved).toHaveBeenCalledWith([{ from: "name", to: "full name" }]);
  expect(api.renameTableFields).toHaveBeenCalledOnce();
});

it("rejects empty and duplicate names, preserves a failed draft, and asks before discarding", async () => {
  api.renameTableFields.mockRejectedValueOnce(
    new Error("Rename permission denied"),
  );
  const onClose = vi.fn();
  render(
    <TableStructure request={request} onClose={onClose} onEdit={vi.fn()} />,
  );
  await screen.findByRole("table", { name: "Table fields" });
  const input = screen.getByRole("textbox", { name: "Field name name" });
  fireEvent.change(input, { target: { value: "" } });
  expect(screen.getByRole("alert").textContent).toContain("cannot be empty");
  fireEvent.keyDown(input, { key: "s", ctrlKey: true });
  expect(api.renameTableFields).not.toHaveBeenCalled();
  fireEvent.change(input, { target: { value: "ID" } });
  expect(screen.getByRole("alert").textContent).toContain("already exists");
  fireEvent.change(input, { target: { value: "full name" } });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Rename permission denied",
    ),
  );
  expect((input as HTMLInputElement).value).toBe("full name");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
  expect((input as HTMLInputElement).value).toBe("full name");
  fireEvent.click(screen.getByRole("button", { name: "Close" }));
  fireEvent.click(screen.getByRole("button", { name: "Discard changes" }));
  expect(onClose).toHaveBeenCalledOnce();
});

it("blocks saving when the workspace has unsaved records", async () => {
  render(
    <TableStructure
      request={request}
      onClose={vi.fn()}
      onEdit={vi.fn()}
      onBeforeSave={() => {
        throw new Error("Save pending record edits first");
      }}
    />,
  );
  await screen.findByRole("table", { name: "Table fields" });
  fireEvent.change(screen.getByRole("textbox", { name: "Field name name" }), {
    target: { value: "full name" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await screen.findByRole("alert");
  expect(api.renameTableFields).not.toHaveBeenCalled();
});

it("edits type, dimensions, nullability, comment, defaults and collation with executable preview before saving", async () => {
  render(
    <TableStructure request={request} onClose={vi.fn()} onEdit={vi.fn()} />,
  );
  await screen.findByRole("table", { name: "Table fields" });
  fireEvent.focus(screen.getByRole("textbox", { name: "Field name name" }));
  fireEvent.change(screen.getByRole("textbox", { name: "name length" }), {
    target: { value: "128" },
  });
  fireEvent.click(screen.getByRole("checkbox", { name: "name not null" }));
  fireEvent.change(screen.getByRole("textbox", { name: "name comment" }), {
    target: { value: "Customer display name" },
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Field default value" }),
    { target: { value: "Visitor" } },
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Field collation" }), {
    target: { value: "utf8mb4_bin" },
  });
  expect(api.alterTableFields).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("tab", { name: "SQL Preview" }));
  await waitFor(() =>
    expect(screen.getByLabelText("Table definition SQL").textContent).toContain(
      "varchar(128)",
    ),
  );
  expect(api.alterTableFields).toHaveBeenCalledWith(
    "local",
    "app",
    request.table,
    [
      expect.objectContaining({
        from: "name",
        to: "name",
        patch: expect.objectContaining({
          data_type: expect.objectContaining({
            name: "varchar",
            length: "128",
          }),
          not_null: true,
          comment: "Customer display name",
          default: { kind: "value", value: "Visitor" },
          collation: "utf8mb4_bin",
        }),
      }),
    ],
    true,
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(
      api.alterTableFields.mock.calls.some((call) => call[4] !== true),
    ).toBe(true),
  );
  expect(api.renameTableFields).not.toHaveBeenCalled();
});

it("validates generated expressions and stages the virtual/storage settings", async () => {
  render(
    <TableStructure request={request} onClose={vi.fn()} onEdit={vi.fn()} />,
  );
  await screen.findByRole("table", { name: "Table fields" });
  fireEvent.click(screen.getByRole("checkbox", { name: "name virtual" }));
  expect(screen.getByRole("alert").textContent).toContain(
    "generated field expression",
  );
  expect(
    (screen.getByRole("button", { name: "Save" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Generated expression" }),
    { target: { value: "upper('guest')" } },
  );
  fireEvent.change(
    screen.getByRole("combobox", { name: "Generated storage" }),
    { target: { value: "stored" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(api.alterTableFields).toHaveBeenCalledWith(
      "local",
      "app",
      request.table,
      [
        expect.objectContaining({
          patch: expect.objectContaining({
            generated: true,
            stored: true,
            expression: "upper('guest')",
          }),
        }),
      ],
    ),
  );
});

it("shows indexes and SQL, copies the definition, and opens a reviewed SQL edit without executing changes", async () => {
  const onEdit = vi.fn();
  render(
    <TableStructure request={request} onClose={vi.fn()} onEdit={onEdit} />,
  );
  await screen.findByRole("table", { name: "Table fields" });
  fireEvent.click(screen.getByRole("tab", { name: "Indexes" }));
  expect(screen.getByRole("heading", { name: "PRIMARY" })).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "SQL Preview" }));
  expect(screen.getByLabelText("Table definition SQL").textContent).toContain(
    "CREATE TABLE",
  );
  fireEvent.click(screen.getByRole("button", { name: "Copy SQL" }));
  await screen.findByRole("button", { name: "Copied" });
  expect(clipboard).toHaveBeenCalledWith(
    await api.tableDdl.mock.results[0].value,
  );
  fireEvent.click(screen.getByRole("button", { name: "SQL Editor" }));
  expect(onEdit).toHaveBeenCalledWith(
    expect.stringContaining("ALTER TABLE `app`.`customers`"),
  );
  expect(onEdit.mock.calls[0][0]).toContain("-- CREATE TABLE");
});

it("supports retry after a metadata failure and returns keyboard focus on close", async () => {
  api.columns.mockRejectedValueOnce(new Error("Connection lost"));
  const onClose = vi.fn();
  render(
    <TableStructure request={request} onClose={onClose} onEdit={vi.fn()} />,
  );
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Connection lost",
  );
  expect(
    (screen.getByRole("button", { name: "SQL Editor" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByRole("table", { name: "Table fields" });
  fireEvent.keyDown(screen.getByRole("tab", { name: "Fields" }), {
    key: "ArrowRight",
  });
  expect(document.activeElement).toBe(
    screen.getByRole("tab", { name: "Indexes" }),
  );
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(onClose).toHaveBeenCalledOnce();
});

it("shows views without index actions and leaves SQL editing available after a clipboard failure", async () => {
  clipboard.mockRejectedValue(new Error("Clipboard denied"));
  render(
    <TableStructure
      request={{ ...request, table: { ...request.table, kind: "view" } }}
      onClose={vi.fn()}
      onEdit={vi.fn()}
    />,
  );
  await screen.findByRole("table", { name: "Table fields" });
  expect(api.listIndexes).not.toHaveBeenCalled();
  expect(screen.queryByRole("tab", { name: "Indexes" })).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "SQL Preview" }));
  fireEvent.click(screen.getByRole("button", { name: "Copy SQL" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "Clipboard denied",
  );
  expect(
    (screen.getByRole("button", { name: "SQL Editor" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
