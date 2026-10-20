// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import App from "./App";
import { useWorkspace } from "./store";
import type { ConnectionConfig } from "./types";
const api = vi.hoisted(() => ({
  execute: vi.fn(),
  explain: vi.fn(),
  maintainTables: vi.fn(),
  sessionInTransaction: vi.fn(),
  closeSession: vi.fn(),
  cancelQuery: vi.fn(),
  tableDdl: vi.fn(),
  saveFile: vi.fn(),
  exportTable: vi.fn(),
  exportRows: vi.fn(),
  cancelExport: vi.fn(),
  importTarget: vi.fn(),
  openImportFile: vi.fn(),
  previewImport: vi.fn(),
  closeImport: vi.fn(),
  importRowCount: vi.fn(),
  runImport: vi.fn(),
  cancelImport: vi.fn(),
  listIndexes: vi.fn(),
  columns: vi.fn(),
  disconnect: vi.fn(),
  clearTable: vi.fn(),
  dropTable: vi.fn(),
  renameTable: vi.fn(),
  closeDatabase: vi.fn(),
  manageDatabase: vi.fn(),
  openSqlFile: vi.fn(),
  listDatabases: vi.fn(),
  createTable: vi.fn(),
  renameTableFields: vi.fn(),
  alterTableFields: vi.fn(),
  pasteTable: vi.fn(),
  viewTable: vi.fn(),
  schema: vi.fn(),
  listProfiles: vi.fn(),
  connect: vi.fn(),
  connectFresh: vi.fn(),
  testConnection: vi.fn(),
  saveProfile: vi.fn(),
  deleteProfile: vi.fn(),
  moveTabToWindow: vi.fn(),
  closeDetachedWindow: vi.fn(),
  guardDetachedWindowClose: vi.fn(),
  listHistory: vi.fn(),
  appendHistory: vi.fn(),
  deleteHistory: vi.fn(),
  clearHistory: vi.fn(),
  listLibrary: vi.fn(),
  saveLibraryItems: vi.fn(),
  deleteLibraryItems: vi.fn(),
  onLibraryChange: vi.fn(),
}));
vi.mock("./components/QueryEditor", () => ({
  default: ({ value }: { value: string }) => (
    <textarea aria-label="SQL text" defaultValue={value} />
  ),
}));
vi.mock("./lib/api", () => ({
  desktop: true,
  ...api,
}));
const config: ConnectionConfig = {
  id: "pg",
  name: "Postgres",
  driver: "postgres",
  host: "db.example",
  port: 5432,
  username: "app",
  database: "app",
  file_path: "",
  ssl_mode: "verify-full",
};
const table = { name: "customers", schema: "public", kind: "table" };
function workspace(query: string) {
  useWorkspace.setState({
    singleTab: false,
    sessions: [
      {
        id: "pg",
        config,
        databases: ["app"],
        trees: { app: { database: "app", tables: [table] } },
      },
    ],
    tabs: [
      {
        id: "tab-1",
        name: "Cleanup",
        connectionId: "pg",
        database: "app",
        query,
        running: false,
        timeoutSecs: 600,
      },
    ],
    activeTab: "tab-1",
  });
}
it("auto-connects saved profiles once and uses their default query timeout", async () => {
  workspace("SELECT 1");
  const profile = {
    ...config,
    id: "startup-profile",
    name: "Startup",
    host: "startup.local",
    options: { auto_connect: true, query_timeout_secs: 75 },
  };
  api.listProfiles.mockResolvedValue([profile]);
  render(<App />);
  await waitFor(() =>
    expect(
      useWorkspace
        .getState()
        .sessions.some((session) => session.id === "replacement"),
    ).toBe(true),
  );
  expect(api.connect).toHaveBeenCalledTimes(1);
  expect(
    useWorkspace
      .getState()
      .tabs.find((tab) => tab.connectionId === "replacement")?.timeoutSecs,
  ).toBe(75);
});
beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  for (const fn of Object.values(api)) fn.mockReset();
  api.execute.mockResolvedValue({
    columns: [],
    rows: [],
    affected_rows: 0,
    execution_ms: 1,
    truncated: false,
  });
  api.sessionInTransaction.mockResolvedValue(false);
  api.closeSession.mockResolvedValue(undefined);
  api.closeDatabase.mockResolvedValue(undefined);
  api.manageDatabase.mockResolvedValue(undefined);
  api.openSqlFile.mockResolvedValue(null);
  api.listDatabases.mockResolvedValue(["app", "other"]);
  api.schema.mockResolvedValue({ database: "app", tables: [] });
  api.listProfiles.mockResolvedValue([]);
  api.connect.mockResolvedValue("replacement");
  api.connectFresh.mockResolvedValue("replacement");
  api.testConnection.mockResolvedValue(true);
  api.saveProfile.mockResolvedValue(undefined);
  api.deleteProfile.mockResolvedValue(undefined);
  api.guardDetachedWindowClose.mockResolvedValue(() => {});
  api.listIndexes.mockResolvedValue([]);
  api.columns.mockResolvedValue([]);
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const dialog = () => screen.getByRole("alertdialog");
describe("safety prompts", () => {
  it("asks before running destructive SQL and then runs it on the tab's session", async () => {
    workspace("DELETE FROM customers;");
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
    expect(
      await within(dialog()).findByText("DELETE FROM customers"),
    ).toBeTruthy();
    fireEvent.click(within(dialog()).getByRole("button", { name: "Cancel" }));
    expect(api.execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Run anyway",
      }),
    );
    await waitFor(() =>
      expect(api.execute).toHaveBeenCalledWith(
        "pg",
        "DELETE FROM customers;",
        "app",
        "tab-1",
        600,
      ),
    );
  });
  it("runs filtered statements without a prompt", async () => {
    workspace("DELETE FROM customers WHERE id = 3;");
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
    await waitFor(() => expect(api.execute).toHaveBeenCalled());
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
  it("warns before closing a tab with an open transaction", async () => {
    workspace("BEGIN;");
    api.sessionInTransaction.mockResolvedValue(true);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: "Close Cleanup" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    expect(useWorkspace.getState().tabs).toHaveLength(1);
    expect(api.closeSession).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: "Close Cleanup" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Roll back and continue",
      }),
    );
    await waitFor(() => expect(useWorkspace.getState().tabs).toHaveLength(0));
    expect(api.closeSession).toHaveBeenCalledWith("pg", "tab-1");
  });
  it("drops a table only after acknowledging the permanent deletion", async () => {
    workspace("SELECT 1");
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for customers" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Drop table/ }));
    const prompt = await screen.findByRole("alertdialog");
    const button = within(prompt).getByRole("button", {
      name: "Delete",
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(api.dropTable).not.toHaveBeenCalled();
    fireEvent.click(
      within(prompt).getByRole("checkbox", { name: /I understand/ }),
    );
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    await waitFor(() =>
      expect(api.dropTable).toHaveBeenCalledWith("pg", "app", table, "default"),
    );
  });
  it("exports a table's schema through the save dialog", async () => {
    workspace("SELECT 1");
    api.tableDdl.mockResolvedValue("CREATE TABLE customers ();");
    api.saveFile.mockResolvedValue("/tmp/customers.sql");
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for customers" }),
    );
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Dump SQL · structure$/ }),
    );
    await waitFor(() =>
      expect(api.saveFile).toHaveBeenCalledWith(
        "customers.sql",
        "sql",
        "CREATE TABLE customers ();\n",
      ),
    );
    expect(
      await screen.findByText(/SQL saved to \/tmp\/customers.sql/),
    ).toBeTruthy();
  });
});

it("opens the export wizard from the table menu and reports the saved file", async () => {
  workspace("SELECT 1");
  api.columns.mockResolvedValue([
    { name: "id", data_type: "int", nullable: false },
    { name: "email", data_type: "text", nullable: true },
  ]);
  api.exportTable.mockResolvedValue({
    path: "/tmp/customers.csv",
    rows: 2,
    sheets: 1,
    truncated_cells: 0,
  });
  render(<App />);
  fireEvent.click(
    screen.getByRole("button", { name: "Actions for customers" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Export…" }));
  const wizard = await screen.findByRole("dialog", {
    name: /Export public\.customers/,
  });
  expect(api.columns).toHaveBeenCalledWith("pg", table, "app");
  expect(within(wizard).getByRole("checkbox", { name: "email" })).toBeTruthy();
  fireEvent.click(within(wizard).getByRole("button", { name: /Export…/ }));
  await waitFor(() =>
    expect(api.exportTable).toHaveBeenCalledWith(
      "pg",
      "app",
      table,
      expect.objectContaining({ format: "csv", columns: ["id", "email"] }),
      {},
      expect.any(String),
      expect.any(Function),
    ),
  );
  expect(
    await screen.findByText("Exported 2 rows to /tmp/customers.csv."),
  ).toBeTruthy();
  expect(
    screen.queryByRole("dialog", { name: /Export public\.customers/ }),
  ).toBeNull();
});
describe("import wizard wiring", () => {
  const importPreview = {
    import_id: "imp1",
    file_name: "customers.csv",
    file_size: 20,
    options: {
      format: "csv",
      delimiter: ",",
      quote: '"',
      header: true,
      null_text: "",
    },
    sheets: [],
    columns: ["id", "email"],
    rows: [["1", "a@x"]],
    row_errors: [],
    estimated_rows: 1,
    exact_rows: true,
  };
  beforeEach(() => {
    api.importTarget.mockResolvedValue({
      columns: [
        {
          name: "id",
          data_type: "integer",
          nullable: false,
          has_default: true,
          generated: false,
        },
        {
          name: "email",
          data_type: "text",
          nullable: true,
          has_default: false,
          generated: false,
        },
      ],
      primary_keys: ["id"],
      transactional: true,
    });
    api.openImportFile.mockResolvedValue(importPreview);
    api.closeImport.mockResolvedValue(undefined);
    api.runImport.mockResolvedValue({
      rows: 1,
      inserted: 1,
      updated: 0,
      skipped: 0,
      failed: 0,
      deleted: 0,
      errors: [],
      more_errors: 0,
    });
  });
  async function importFromMenu() {
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for customers" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Import…" }));
    const wizard = await screen.findByRole("dialog", {
      name: /Import into public\.customers/,
    });
    await waitFor(() =>
      expect(api.importTarget).toHaveBeenCalledWith("pg", "app", table),
    );
    fireEvent.click(
      within(wizard).getByRole("button", { name: /Choose file/ }),
    );
    await within(wizard).findByText(/customers\.csv/);
    fireEvent.click(within(wizard).getByRole("button", { name: "Next" }));
    fireEvent.click(within(wizard).getByRole("button", { name: "Next" }));
    fireEvent.click(within(wizard).getByRole("button", { name: /^Import$/ }));
    return wizard;
  }
  it("imports from the table menu, then invalidates the explorer cache", async () => {
    workspace("SELECT 1");
    render(<App />);
    const wizard = await importFromMenu();
    await waitFor(() =>
      expect(api.runImport).toHaveBeenCalledWith(
        "pg",
        "app",
        table,
        "imp1",
        expect.objectContaining({
          mode: "append",
          mapping: [
            { source: "id", target: "id" },
            { source: "email", target: "email" },
          ],
        }),
        expect.any(Function),
      ),
    );
    expect(await screen.findByText("customers: Inserted 1 row.")).toBeTruthy();
    // The cached tree (which listed customers) was dropped and reloaded.
    await waitFor(() =>
      expect(useWorkspace.getState().sessions[0].trees?.app?.tables).toEqual(
        [],
      ),
    );
    expect(within(wizard).getByText("Inserted 1 row.")).toBeTruthy();
  });
  it("asks before discarding staged edits and rolling back open transactions on the table", async () => {
    workspace("SELECT 1");
    useWorkspace.getState().updateTab("tab-1", {
      tableIdentity: { database: "app", schema: "public", name: "customers" },
      staged: {
        edits: { "[1]": { key: { id: 1 }, values: { email: "pending" } } },
        deletes: {},
        drafts: [],
        transaction: false,
      },
    });
    render(<App />);
    await importFromMenu();
    const prompt = await screen.findByRole("alertdialog");
    expect(prompt.textContent).toMatch(
      /Importing into the table discards them/,
    );
    fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
    expect(
      await screen.findByText(/Import cancelled\. Unsaved changes/),
    ).toBeTruthy();
    expect(api.runImport).not.toHaveBeenCalled();
    expect(useWorkspace.getState().tabs[0].staged).toBeDefined();
    api.sessionInTransaction.mockResolvedValue(true);
    fireEvent.click(screen.getByRole("button", { name: /^Import$/ }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Discard changes",
      }),
    );
    const rollback = await screen.findByText("Roll back the open transaction?");
    fireEvent.click(
      within(rollback.closest("section")!).getByRole("button", {
        name: "Roll back and continue",
      }),
    );
    await waitFor(() => expect(api.runImport).toHaveBeenCalled());
    expect(api.closeSession).toHaveBeenCalledWith("pg", "tab-1");
    await waitFor(() =>
      expect(useWorkspace.getState().tabs[0].staged).toBeUndefined(),
    );
  });
});
it("opens DDL in a read-only dialog without adding tabs or executing it", async () => {
  workspace("SELECT 1");
  api.tableDdl.mockResolvedValue("CREATE TABLE customers (id INT);");
  api.saveFile.mockResolvedValue("/tmp/customers.sql");
  const writeText = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { writeText },
  });
  render(<App />);
  const tabs = useWorkspace.getState().tabs.length;
  fireEvent.click(
    screen.getByRole("button", { name: "Actions for customers" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "View DDL" }));
  const dialog = await screen.findByRole("dialog", {
    name: /DDL · public\.customers/,
  });
  expect(
    within(dialog).getByLabelText("Definition of public.customers").textContent,
  ).toBe("CREATE TABLE customers (id INT);");
  expect(within(dialog).getByText(/Triggers, comments, grants/)).toBeTruthy();
  expect(useWorkspace.getState().tabs).toHaveLength(tabs);
  fireEvent.click(within(dialog).getByRole("button", { name: /Copy/ }));
  await waitFor(() =>
    expect(writeText).toHaveBeenCalledWith("CREATE TABLE customers (id INT);"),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: /Save \.sql/ }));
  await waitFor(() =>
    expect(api.saveFile).toHaveBeenCalledWith(
      "customers.sql",
      "sql",
      "CREATE TABLE customers (id INT);\n",
    ),
  );
  expect(
    await within(dialog).findByText("Saved to /tmp/customers.sql"),
  ).toBeTruthy();
  fireEvent.click(
    within(dialog).getByRole("button", { name: /Open in SQL Editor/ }),
  );
  expect(screen.queryByRole("dialog", { name: /DDL ·/ })).toBeNull();
  expect(
    useWorkspace
      .getState()
      .tabs.some(
        (t) =>
          t.name === "DDL · customers" &&
          t.query.includes("CREATE TABLE customers"),
      ),
  ).toBe(true);
  expect(api.execute).not.toHaveBeenCalled();
});
it("keeps unsaved records when a sidebar empty action is cancelled at the discard prompt", async () => {
  workspace("SELECT 1");
  useWorkspace.getState().updateTab("tab-1", {
    tableIdentity: { database: "app", schema: "public", name: "customers" },
    staged: {
      edits: { "[1]": { key: { id: 1 }, values: { name: "unsaved" } } },
      deletes: {},
      drafts: [],
      transaction: false,
    },
  });
  render(<App />);
  fireEvent.click(
    screen.getByRole("button", { name: "Actions for customers" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: /Empty table/ }));
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Empty table",
    }),
  );
  await waitFor(() =>
    expect(screen.getByText("Discard unsaved table changes?")).toBeTruthy(),
  );
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Cancel",
    }),
  );
  expect(api.clearTable).not.toHaveBeenCalled();
  expect(useWorkspace.getState().tabs[0].staged?.edits["[1]"]?.values).toEqual({
    name: "unsaved",
  });
});

it("matches the requested database menu, omits excluded actions, and opens a new-database form", async () => {
  workspace("SELECT 1");
  render(<App />);
  const database = screen.getByRole("button", { name: "app" });
  fireEvent.contextMenu(database, { clientX: 100, clientY: 120 });
  let menu = screen.getByRole("menu", { name: "app database actions" });
  expect(
    within(menu)
      .getAllByRole("menuitem")
      .map((item) =>
        item.textContent
          ?.replace(/Ctrl\+Shift\+\.|Ctrl\+Y|Ctrl\+R/g, "")
          .trim(),
      ),
  ).toEqual([
    "Close Database",
    "Edit Database…",
    "New Database…",
    "Delete Database",
    "New Table…",
    "New Query",
    "Execute SQL File…",
    "Dump SQL File",
    "Find in Database…",
    "Share…",
    "Refresh",
  ]);
  expect(within(menu).queryByText(/Console|Reverse|Dictionary/)).toBeNull();
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(document.activeElement).toBe(database);
  fireEvent.keyDown(database, { key: "F10", shiftKey: true });
  menu = screen.getByRole("menu", { name: "app database actions" });
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: "New Database…" }),
  );
  const form = await screen.findByRole("dialog");
  fireEvent.change(
    within(form).getByRole("textbox", { name: "Database name" }),
    { target: { value: "new_app" } },
  );
  fireEvent.click(
    within(form).getByRole("button", { name: "Create Database" }),
  );
  await waitFor(() =>
    expect(api.manageDatabase).toHaveBeenCalledWith("pg", "app", "create", {
      name: "new_app",
      charset: "utf8mb4",
      collation: "",
    }),
  );
  expect(api.execute).not.toHaveBeenCalled();
});

it("loads the selected SQL file for review and executes only after confirmation", async () => {
  workspace("SELECT 1");
  api.openSqlFile.mockResolvedValue({
    name: "sample.sql",
    contents: "SELECT 42;",
  });
  render(<App />);
  fireEvent.click(
    screen.getByRole("button", { name: "Actions for database app" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Execute SQL File…" }));
  const prompt = await screen.findByRole("alertdialog");
  expect(
    useWorkspace.getState().tabs.some((t) => t.query === "SELECT 42;"),
  ).toBe(true);
  expect(api.execute).not.toHaveBeenCalled();
  fireEvent.click(within(prompt).getByRole("button", { name: "Execute SQL" }));
  await waitFor(() => expect(api.execute).toHaveBeenCalled());
  const tab = useWorkspace
    .getState()
    .tabs.find((t) => t.name === "sample.sql")!;
  expect(api.execute).toHaveBeenCalledWith(
    "pg",
    "SELECT 42;",
    "app",
    tab.id,
    undefined,
  );
});

it("checks unsaved changes before closing database tabs and preserves tabs of other databases", async () => {
  workspace("SELECT 1");
  useWorkspace.getState().updateTab("tab-1", {
    staged: {
      edits: { "[1]": { key: { id: 1 }, values: { name: "unsaved" } } },
      deletes: {},
      drafts: [],
      transaction: false,
    },
  });
  useWorkspace.getState().addTab("pg", "SELECT 2", "Other database", "other");
  useWorkspace.getState().setActive("tab-1");
  render(<App />);
  const close = () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for database app" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /^Close Database/ }));
  };
  close();
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Cancel",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(useWorkspace.getState().tabs).toHaveLength(2);
  expect(api.closeSession).not.toHaveBeenCalled();
  close();
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Discard changes",
    }),
  );
  await waitFor(() => expect(useWorkspace.getState().tabs).toHaveLength(1));
  expect(useWorkspace.getState().tabs[0].database).toBe("other");
  expect(api.closeDatabase).toHaveBeenCalledWith("pg", "app");
  expect(api.disconnect).not.toHaveBeenCalled();
});

it("confirms database deletion and keeps data untouched when cancelled", async () => {
  workspace("SELECT 1");
  render(<App />);
  const openDelete = () => {
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for database app" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Delete Database" }));
  };
  openDelete();
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Cancel",
    }),
  );
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(api.manageDatabase).not.toHaveBeenCalled();
  expect(useWorkspace.getState().tabs).toHaveLength(1);
  openDelete();
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Delete Database",
    }),
  );
  await waitFor(() =>
    expect(api.manageDatabase).toHaveBeenCalledWith("pg", "app", "delete", {
      name: "app",
      charset: "",
      collation: "",
    }),
  );
  expect(useWorkspace.getState().tabs).toHaveLength(0);
});

it("opens the design UI before creating a structure SQL tab", async () => {
  workspace("SELECT 1");
  api.columns.mockResolvedValue([
    { name: "id", data_type: "integer", nullable: false },
  ]);
  api.tableDdl.mockResolvedValue(
    "CREATE TABLE customers (id integer PRIMARY KEY);",
  );
  render(<App />);
  fireEvent.click(
    screen.getByRole("button", { name: "Actions for customers" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: /Design table/ }));
  const designer = await screen.findByRole("dialog", {
    name: /customers.*Design Table/,
  });
  await within(designer).findByRole("table", { name: "Table fields" });
  expect(useWorkspace.getState().tabs).toHaveLength(1);
  expect(
    api.execute.mock.calls.every((call) => /^SELECT /i.test(call[1])),
  ).toBe(true);
  fireEvent.click(within(designer).getByRole("button", { name: "SQL Editor" }));
  expect(
    screen.queryByRole("dialog", { name: /customers.*Design Table/ }),
  ).toBeNull();
  const tab = useWorkspace
    .getState()
    .tabs.find((item) => item.name === "Structure · customers");
  expect(tab?.query).toContain('ALTER TABLE "public"."customers"');
  expect(tab?.database).toBe("app");
});

it("protects unsaved record edits from a field rename in the design UI", async () => {
  workspace("SELECT 1");
  useWorkspace.getState().updateTab("tab-1", {
    tableIdentity: { database: "app", schema: "public", name: "customers" },
    staged: {
      edits: { "[1]": { key: { id: 1 }, values: { name: "unsaved" } } },
      deletes: {},
      drafts: [],
      transaction: false,
    },
  });
  api.columns.mockResolvedValue([
    { name: "name", data_type: "text", nullable: true },
  ]);
  api.tableDdl.mockResolvedValue("CREATE TABLE customers (name text);");
  render(<App />);
  fireEvent.click(
    screen.getByRole("button", { name: "Actions for customers" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: /Design table/ }));
  const designer = await screen.findByRole("dialog", {
    name: /customers.*Design Table/,
  });
  fireEvent.change(
    await within(designer).findByRole("textbox", { name: "Field name name" }),
    { target: { value: "full_name" } },
  );
  fireEvent.click(within(designer).getByRole("button", { name: "Save" }));
  await waitFor(() =>
    expect(within(designer).getByRole("alert").textContent).toContain(
      "pending record edits",
    ),
  );
  expect(api.renameTableFields).not.toHaveBeenCalled();
  expect(useWorkspace.getState().tabs[0].staged?.edits["[1]"].values.name).toBe(
    "unsaved",
  );
});

it("reloads table header types after saving a field property without renaming it", async () => {
  workspace("SELECT 1");
  useWorkspace
    .getState()
    .updateSession("pg", { config: { ...config, driver: "mysql" } });
  const result = {
    columns: ["name"],
    rows: [["Ada"]],
    affected_rows: 0,
    execution_ms: 1,
    truncated: false,
    source: { database: "app", table, primary_keys: [] },
    pagination: { page: 1, page_size: 1000, total_rows: 1 },
  };
  useWorkspace.getState().updateTab("tab-1", {
    tableIdentity: {
      database: "app",
      schema: table.schema,
      name: table.name,
    },
    result,
  });
  let saved = false;
  api.columns.mockImplementation(async () => [
    {
      name: "name",
      data_type: saved ? "varchar(40)" : "varchar(20)",
      nullable: true,
    },
  ]);
  api.execute.mockImplementation(async (_id, sql) =>
    sql.includes("information_schema.COLUMNS")
      ? {
          columns: [
            "name",
            "full_type",
            "nullable",
            "default_value",
            "comment",
            "extra",
          ],
          rows: [
            [
              "name",
              saved ? "varchar(40)" : "varchar(20)",
              "YES",
              null,
              "",
              "",
            ],
          ],
          affected_rows: 0,
          execution_ms: 0,
          truncated: false,
        }
      : {
          columns: [],
          rows: [],
          affected_rows: 0,
          execution_ms: 0,
          truncated: false,
        },
  );
  api.tableDdl.mockResolvedValue(
    "CREATE TABLE `customers` (`name` varchar(20) DEFAULT NULL);",
  );
  api.alterTableFields.mockImplementation(async () => {
    saved = true;
    return "ALTER TABLE customers ...";
  });
  api.viewTable.mockResolvedValue(result);
  render(<App />);
  await screen.findByText("varchar(20)");
  fireEvent.click(
    screen.getByRole("button", { name: "Actions for customers" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: /Design table/ }));
  const designer = await screen.findByRole("dialog", {
    name: /customers.*Design Table/,
  });
  fireEvent.change(
    await within(designer).findByRole("textbox", { name: "name length" }),
    { target: { value: "40" } },
  );
  fireEvent.click(within(designer).getByRole("button", { name: "Save" }));
  await screen.findByText("varchar(40)");
  expect(screen.queryByText("varchar(20)")).toBeNull();
});

it("exposes dump options as a submenu and protects system database administration", async () => {
  workspace("SELECT 1");
  useWorkspace.getState().updateSession("pg", { databases: ["postgres"] });
  render(<App />);
  fireEvent.click(
    screen.getByRole("button", { name: "Actions for database postgres" }),
  );
  expect(
    (
      screen.getByRole("menuitem", {
        name: "Delete Database",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(screen.getByRole("menuitem", { name: "Dump SQL File" }));
  const submenu = screen.getByRole("menu", { name: "Dump SQL File options" });
  expect(
    within(submenu).getByRole("menuitem", { name: "Structure Only" }),
  ).toBeTruthy();
  expect(
    within(submenu).getByRole("menuitem", { name: "Structure and Data" }),
  ).toBeTruthy();
});

it("keeps dump options outside the scrolling menu and within the viewport", () => {
  workspace("SELECT 1");
  vi.stubGlobal("innerWidth", 800);
  vi.stubGlobal("innerHeight", 600);
  const bounds = vi
    .spyOn(HTMLElement.prototype, "getBoundingClientRect")
    .mockImplementation(function (this: HTMLElement) {
      if (this.dataset.dump)
        return {
          left: 700,
          right: 760,
          top: 570,
          bottom: 604,
          width: 60,
          height: 34,
        } as DOMRect;
      if (this.classList.contains("database-dump-submenu"))
        return {
          left: 0,
          right: 224,
          top: 0,
          bottom: 120,
          width: 224,
          height: 120,
        } as DOMRect;
      return {
        left: 0,
        right: 0,
        top: 0,
        bottom: 0,
        width: 0,
        height: 0,
      } as DOMRect;
    });
  try {
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for database app" }),
    );
    const menu = screen.getByRole("menu", { name: "app database actions" });
    const trigger = within(menu).getByRole("menuitem", {
      name: "Dump SQL File",
    });
    trigger.focus();
    fireEvent.keyDown(trigger, { key: "ArrowRight" });
    const submenu = screen.getByRole("menu", { name: "Dump SQL File options" });
    expect(menu.parentElement).toBe(document.body);
    expect(submenu.parentElement).toBe(document.body);
    expect(menu.contains(submenu)).toBe(false);
    expect(submenu.style.left).toBe("470px");
    expect(submenu.style.top).toBe("472px");
    const first = within(submenu).getByRole("menuitem", {
      name: "Structure Only",
    });
    const second = within(submenu).getByRole("menuitem", {
      name: "Structure and Data",
    });
    expect(document.activeElement).toBe(first);
    fireEvent.keyDown(first, { key: "ArrowDown" });
    expect(document.activeElement).toBe(second);
    fireEvent.mouseDown(second);
    expect(screen.getByRole("menu", { name: "Dump SQL File options" })).toBe(
      submenu,
    );
    fireEvent.keyDown(second, { key: "Escape" });
    expect(
      screen.queryByRole("menu", { name: "Dump SQL File options" }),
    ).toBeNull();
    expect(document.activeElement).toBe(trigger);
    expect(screen.getByRole("menu", { name: "app database actions" })).toBe(
      menu,
    );
    fireEvent.mouseEnter(trigger);
    expect(
      screen.getByRole("menu", { name: "Dump SQL File options" }),
    ).toBeTruthy();
    fireEvent.scroll(menu);
    expect(
      screen.queryByRole("menu", { name: "Dump SQL File options" }),
    ).toBeNull();
    fireEvent.mouseDown(document.body);
    expect(
      screen.queryByRole("menu", { name: "app database actions" }),
    ).toBeNull();
  } finally {
    bounds.mockRestore();
  }
});

it("keeps the database edit form available when cancelling its unsaved-changes confirmation", async () => {
  workspace("SELECT 1");
  useWorkspace.getState().updateTab("tab-1", {
    staged: {
      edits: { "[1]": { key: { id: 1 }, values: { name: "pending" } } },
      deletes: {},
      drafts: [],
      transaction: false,
    },
  });
  render(<App />);
  fireEvent.click(
    screen.getByRole("button", { name: "Actions for database app" }),
  );
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit Database…" }));
  const form = await screen.findByRole("dialog");
  fireEvent.change(
    within(form).getByRole("textbox", { name: "Database name" }),
    { target: { value: "renamed" } },
  );
  fireEvent.click(within(form).getByRole("button", { name: "Save Changes" }));
  const prompt = await screen.findByRole("alertdialog");
  fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
  await waitFor(() =>
    expect(within(form).getByRole("alert").textContent).toContain(
      "Rename cancelled",
    ),
  );
  expect(api.manageDatabase).not.toHaveBeenCalled();
  expect(useWorkspace.getState().tabs[0].staged?.edits["[1]"]?.values).toEqual({
    name: "pending",
  });
});

it("refreshes a focused connection without listing other server databases", async () => {
  workspace("SELECT 1");
  useWorkspace.getState().updateSession("pg", {
    config: { ...config, database_only: true },
    databases: ["app", "other"],
  });
  api.listDatabases.mockClear();
  render(<App />);
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh databases for Postgres" }),
  );
  await waitFor(() =>
    expect(useWorkspace.getState().sessions[0].databases).toEqual(["app"]),
  );
  expect(api.listDatabases).not.toHaveBeenCalled();
  expect(
    screen.queryByRole("button", { name: "Open database other" }),
  ).toBeNull();
});

it("opens the table designer from the database sidebar", async () => {
  workspace("SELECT 1");
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "New table in app" }));
  expect(screen.getByRole("dialog", { name: /New Table/ })).toBeTruthy();
  expect(screen.getByRole("tab", { name: /Fields/ })).toBeTruthy();
  expect(
    screen.getByRole("textbox", { name: "Table schema" }).getAttribute("value"),
  ).toBe("public");
  fireEvent.click(screen.getByRole("button", { name: "Close table designer" }));
  expect(screen.queryByRole("dialog", { name: /New Table/ })).toBeNull();
});

it("creates a table, refreshes the sidebar tree and opens its data tab", async () => {
  workspace("SELECT 1");
  const created = { name: "new_customers", schema: "public", kind: "table" };
  api.createTable.mockResolvedValue(created);
  api.schema.mockResolvedValue({ database: "app", tables: [table, created] });
  api.viewTable.mockResolvedValue({
    columns: ["id"],
    rows: [],
    affected_rows: 0,
    execution_ms: 1,
    truncated: false,
    source: { database: "app", table: created, primary_keys: ["id"] },
  });
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "New table in app" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Table name" }), {
    target: { value: "new_customers" },
  });
  fireEvent.click(
    within(screen.getByRole("dialog")).getByRole("button", { name: /Save/ }),
  );
  await waitFor(() =>
    expect(api.createTable).toHaveBeenCalledWith(
      "pg",
      "app",
      expect.objectContaining({ name: "new_customers", schema: "public" }),
    ),
  );
  await waitFor(() =>
    expect(
      useWorkspace.getState().sessions[0].trees?.app.tables,
    ).toContainEqual(created),
  );
  await waitFor(() =>
    expect(
      useWorkspace
        .getState()
        .tabs.find((t) => t.tableIdentity?.name === "new_customers")?.result
        ?.source?.table,
    ).toEqual(created),
  );
  expect(screen.queryByRole("dialog", { name: /New Table/ })).toBeNull();
});

it("searches unopened databases and reveals matching table branches", async () => {
  workspace("SELECT 1");
  useWorkspace
    .getState()
    .updateSession("pg", { databases: ["app", "warehouse"] });
  const orders = { name: "sales_orders", schema: "public", kind: "table" };
  api.schema.mockImplementation(async (_id: string, database: string) => ({
    database,
    tables: database === "warehouse" ? [orders] : [table],
  }));
  render(<App />);
  const search = screen.getByRole("textbox", {
    name: "Find database or table",
  });
  fireEvent.change(search, { target: { value: " SALES_ " } });
  await waitFor(() =>
    expect(api.schema).toHaveBeenCalledWith("pg", "warehouse"),
  );
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Actions for sales_orders" }),
    ).toBeTruthy(),
  );
  expect(
    screen.queryByRole("button", { name: "Actions for database app" }),
  ).toBeNull();
  expect(
    screen.getByRole("button", { name: "Actions for database warehouse" }),
  ).toBeTruthy();
  expect(api.execute).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Clear sidebar search" }));
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Actions for database app" }),
    ).toBeTruthy(),
  );
  expect(
    screen.queryByRole("button", { name: "Actions for sales_orders" }),
  ).toBeNull();
});

it("matches a database name and keeps all of its tables visible", async () => {
  workspace("SELECT 1");
  render(<App />);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Find database or table" }),
    { target: { value: " APP " } },
  );
  expect(
    screen.getByRole("button", { name: "Actions for database app" }),
  ).toBeTruthy();
  expect(
    screen.getByRole("button", { name: "Actions for customers" }),
  ).toBeTruthy();
  fireEvent.change(
    screen.getByRole("textbox", { name: "Find database or table" }),
    { target: { value: "no_such_table" } },
  );
  expect(screen.getByText("No matching databases or tables.")).toBeTruthy();
});

const connectionMenu = async () => {
  fireEvent.click(
    screen.getByRole("button", { name: "Actions for connection Postgres" }),
  );
  return screen.getByRole("menu", { name: "Postgres connection actions" });
};
it("stores connection star, color and group without database calls", async () => {
  workspace("SELECT 1");
  render(<App />);
  await connectionMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Add Star" }));
  await connectionMenu();
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Color green" }));
  await connectionMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Manage Group" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "New Group…" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Group name" }), {
    target: { value: "Local servers" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save group" }));
  await waitFor(() =>
    expect(
      JSON.parse(localStorage.getItem("dbde.connection-appearance") || "{}").pg,
    ).toEqual({ starred: true, color: "#76d5a4", group: "Local servers" }),
  );
  expect(api.execute).not.toHaveBeenCalled();
  expect(api.disconnect).not.toHaveBeenCalled();
});
it("keeps an active connection and its draft when Close is cancelled", async () => {
  workspace("SELECT 1");
  useWorkspace.getState().updateTab("tab-1", {
    staged: {
      edits: { "[1]": { key: { id: 1 }, values: { name: "pending" } } },
      deletes: {},
      drafts: [],
      transaction: false,
    },
  });
  render(<App />);
  await connectionMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /^Close Connection/ }));
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Cancel",
    }),
  );
  expect(useWorkspace.getState().sessions).toHaveLength(1);
  expect(useWorkspace.getState().tabs[0].staged?.edits["[1]"]?.values).toEqual({
    name: "pending",
  });
  expect(api.disconnect).not.toHaveBeenCalled();
});
it("edits a saved connection label while preserving its open tabs and stored password", async () => {
  workspace("SELECT 1");
  api.listProfiles.mockResolvedValue([config]);
  render(<App />);
  await connectionMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit Connection…" }));
  await screen.findByRole("dialog", { name: "Edit Connection" });
  fireEvent.change(screen.getByRole("textbox", { name: "Connection name" }), {
    target: { value: "Renamed" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await waitFor(() =>
    expect(api.saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({ name: "Renamed", password: undefined }),
    ),
  );
  await waitFor(() =>
    expect(useWorkspace.getState().sessions[0].config.name).toBe("Renamed"),
  );
  expect(useWorkspace.getState().tabs[0].id).toBe("tab-1");
  expect(api.connectFresh).not.toHaveBeenCalled();
  expect(api.disconnect).not.toHaveBeenCalled();
});
it("keeps the current connection if replacement login fails", async () => {
  workspace("SELECT 1");
  api.listProfiles.mockResolvedValue([config]);
  api.connectFresh.mockRejectedValue(new Error("Access denied"));
  render(<App />);
  await connectionMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Edit Connection…" }));
  await screen.findByRole("dialog", { name: "Edit Connection" });
  fireEvent.change(screen.getByRole("textbox", { name: "Host" }), {
    target: { value: "new.example" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save changes" }));
  await screen.findByText(/Access denied/);
  expect(useWorkspace.getState().sessions[0].id).toBe("pg");
  expect(useWorkspace.getState().tabs[0].id).toBe("tab-1");
  expect(api.disconnect).not.toHaveBeenCalled();
  expect(api.saveProfile).not.toHaveBeenCalled();
});
it("duplicates a profile with separately supplied credentials, without replacing the active connection", async () => {
  workspace("SELECT 1");
  render(<App />);
  await connectionMenu();
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Duplicate Connection…" }),
  );
  await screen.findByRole("dialog", { name: "Duplicate Connection" });
  fireEvent.change(screen.getByLabelText("Password"), {
    target: { value: "duplicate-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Save duplicate" }));
  await waitFor(() =>
    expect(api.saveProfile).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "Postgres copy",
        password: "duplicate-secret",
      }),
    ),
  );
  expect(api.saveProfile.mock.calls[0][0].id).not.toBe("pg");
  expect(api.testConnection).toHaveBeenCalledWith(
    expect.objectContaining({ password: "duplicate-secret" }),
  );
  expect(api.connect).not.toHaveBeenCalled();
  expect(api.disconnect).not.toHaveBeenCalled();
  expect(useWorkspace.getState().sessions[0].id).toBe("pg");
});
it("asks before deleting a connection profile and never runs DROP DATABASE", async () => {
  workspace("SELECT 1");
  api.listProfiles.mockResolvedValue([config]);
  render(<App />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Remove Postgres" }),
    ).toBeTruthy(),
  );
  await connectionMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete Connection" }));
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Cancel",
    }),
  );
  expect(api.deleteProfile).not.toHaveBeenCalled();
  expect(api.disconnect).not.toHaveBeenCalled();
  await connectionMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Delete Connection" }));
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Delete Connection",
    }),
  );
  await waitFor(() => expect(api.deleteProfile).toHaveBeenCalledWith("pg"));
  expect(api.disconnect).toHaveBeenCalledWith("pg");
  expect(api.execute).not.toHaveBeenCalled();
  expect(useWorkspace.getState().sessions).toHaveLength(0);
});
it("opens a query and SQL-file database selection through the connection menu", async () => {
  workspace("SELECT 1");
  render(<App />);
  await connectionMenu();
  expect(screen.queryByRole("menuitem", { name: "Console" })).toBeNull();
  fireEvent.click(screen.getByRole("menuitem", { name: /^New Query/ }));
  await waitFor(() =>
    expect(
      useWorkspace
        .getState()
        .tabs.some((t) => t.name === "Query" && t.database === "app"),
    ).toBe(true),
  );
  await connectionMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Execute SQL File…" }));
  await screen.findByRole("dialog", { name: "Execute SQL File" });
  expect(api.openSqlFile).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Choose SQL file…" }));
  await waitFor(() => expect(api.openSqlFile).toHaveBeenCalled());
});
it("opens one database table-list tab and keeps sidebar expansion independent", async () => {
  workspace("SELECT 1");
  render(<App />);
  fireEvent.click(
    within(screen.getByRole("complementary")).getByRole("button", {
      name: "app",
    }),
  );
  const list = await screen.findByRole("table", { name: "Table list for app" });
  expect(
    within(list)
      .getAllByRole("columnheader")
      .map((header) => header.textContent),
  ).toEqual([
    "Name",
    "Rows",
    "Data Length",
    "Engine",
    "Created Date",
    "Modified Date",
    "Collation",
    "Comment",
  ]);
  expect(within(list).getByText("public")).toBeTruthy();
  expect(screen.queryByRole("button", { name: /Run query/ })).toBeNull();
  const databaseTab = useWorkspace.getState().activeTab;
  expect(useWorkspace.getState().tabs).toHaveLength(2);
  fireEvent.click(
    screen.getByRole("button", { name: "Collapse database app" }),
  );
  expect(useWorkspace.getState().activeTab).toBe(databaseTab);
  fireEvent.click(
    within(screen.getByRole("complementary")).getByRole("button", {
      name: "app",
    }),
  );
  expect(useWorkspace.getState().tabs).toHaveLength(2);
  expect(useWorkspace.getState().tabs[0].query).toBe("SELECT 1");
  fireEvent.change(
    screen.getByRole("textbox", { name: "Search tables in database" }),
    { target: { value: "missing" } },
  );
  expect(screen.getByText("No matching tables")).toBeTruthy();
  fireEvent.change(
    screen.getByRole("textbox", { name: "Search tables in database" }),
    { target: { value: "PUBLIC" } },
  );
  expect(within(list).getByRole("button", { name: "customers" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close app" }));
  await waitFor(() => expect(useWorkspace.getState().tabs).toHaveLength(1));
  expect(api.closeSession).not.toHaveBeenCalled();
  expect(api.sessionInTransaction).not.toHaveBeenCalled();
});

it("opens the table-list context menu without opening data and restores keyboard focus", async () => {
  workspace("SELECT 1");
  api.tableDdl.mockResolvedValue("CREATE TABLE customers (id INTEGER);");
  render(<App />);
  fireEvent.click(
    within(screen.getByRole("complementary")).getByRole("button", {
      name: "app",
    }),
  );
  const list = await screen.findByRole("table", { name: "Table list for app" });
  const customer = within(list).getByRole("button", { name: "customers" });
  fireEvent.contextMenu(customer.closest("tr")!, {
    clientX: 300,
    clientY: 200,
  });
  let menu = screen.getByRole("menu", { name: "customers actions" });
  expect(
    within(menu).getByRole("menuitem", { name: "Copy structure and data…" }),
  ).toBeTruthy();
  expect(customer.closest("tr")?.classList.contains("context-selected")).toBe(
    true,
  );
  expect(useWorkspace.getState().tabs).toHaveLength(2);
  expect(api.viewTable).not.toHaveBeenCalled();
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(document.activeElement).toBe(customer);
  fireEvent.keyDown(customer, { key: "F10", shiftKey: true });
  menu = screen.getByRole("menu", { name: "customers actions" });
  fireEvent.click(within(menu).getByRole("menuitem", { name: "View DDL" }));
  await waitFor(() =>
    expect(api.tableDdl).toHaveBeenCalledWith("pg", table, "app"),
  );
  expect(api.execute).not.toHaveBeenCalled();
});

it("asks before dropping a table from the database-list context menu", async () => {
  workspace("SELECT 1");
  render(<App />);
  fireEvent.click(
    within(screen.getByRole("complementary")).getByRole("button", {
      name: "app",
    }),
  );
  const list = await screen.findByRole("table", { name: "Table list for app" });
  fireEvent.contextMenu(
    within(list).getByRole("button", { name: "customers" }),
  );
  fireEvent.click(
    within(screen.getByRole("menu", { name: "customers actions" })).getByRole(
      "menuitem",
      { name: "Drop table…" },
    ),
  );
  expect(await screen.findByRole("alertdialog")).toBeTruthy();
  expect(api.execute).not.toHaveBeenCalled();
  fireEvent.click(
    within(screen.getByRole("alertdialog")).getByRole("button", {
      name: "Cancel",
    }),
  );
  expect(api.execute).not.toHaveBeenCalled();
  expect(useWorkspace.getState().tabs).toHaveLength(2);
});

it("disables table-only operations for views in the database list", async () => {
  workspace("SELECT 1");
  useWorkspace.getState().updateSession("pg", {
    trees: {
      app: {
        database: "app",
        tables: [{ name: "customer_summary", schema: "public", kind: "view" }],
      },
    },
  });
  render(<App />);
  fireEvent.click(
    within(screen.getByRole("complementary")).getByRole("button", {
      name: "app",
    }),
  );
  const list = await screen.findByRole("table", { name: "Table list for app" });
  fireEvent.contextMenu(
    within(list).getByRole("button", { name: "customer_summary" }),
  );
  const menu = screen.getByRole("menu", { name: "customer_summary actions" });
  for (const name of [
    "Open table quick",
    "Copy structure only…",
    "Empty table…",
    "Truncate…",
  ])
    expect(
      within(menu).getByRole("menuitem", { name }).hasAttribute("disabled"),
    ).toBe(true);
  expect(
    within(menu)
      .getByRole("menuitem", { name: "Drop view…" })
      .hasAttribute("disabled"),
  ).toBe(false);
});

it("shows the database metadata columns, retaining zero values and unavailable markers", async () => {
  workspace("SELECT 1");
  useWorkspace.getState().updateSession("pg", {
    config: { ...config, driver: "mysql" },
    trees: {
      app: {
        database: "app",
        tables: [table],
        table_metadata: [
          {
            name: table.name,
            schema: table.schema,
            rows: 0,
            data_length: 16384,
            engine: "InnoDB",
            created_date: "2026-10-16 10:20:30",
            modified_date: null,
            collation: "utf8mb4_unicode_ci",
            comment: "Customer records",
          },
        ],
      },
    },
  });
  render(<App />);
  fireEvent.click(
    within(screen.getByRole("complementary")).getByRole("button", {
      name: "app",
    }),
  );
  const list = await screen.findByRole("table", { name: "Table list for app" });
  const cells = within(list)
    .getAllByRole("cell")
    .map((cell) => cell.textContent);
  expect(cells).toEqual([
    "customers",
    "0",
    "16 KB",
    "InnoDB",
    "2026-10-16 10:20:30",
    "—",
    "utf8mb4_unicode_ci",
    "Customer records",
  ]);
});

it("loads uncached database tables without running a data query", async () => {
  workspace("SELECT 1");
  useWorkspace.getState().updateSession("pg", { trees: {} });
  api.schema.mockResolvedValue({ database: "app", tables: [table] });
  render(<App />);
  fireEvent.click(
    within(screen.getByRole("complementary")).getByRole("button", {
      name: "app",
    }),
  );
  const list = await screen.findByRole("table", { name: "Table list for app" });
  expect(
    await within(list).findByRole("button", { name: "customers" }),
  ).toBeTruthy();
  expect(api.schema).toHaveBeenCalledWith("pg", "app");
  expect(api.execute).not.toHaveBeenCalled();
  expect(
    screen
      .getByRole("button", { name: "Refresh database tables" })
      .hasAttribute("disabled"),
  ).toBe(false);
});

it("opens table data and the new-table designer from the database list", async () => {
  workspace("SELECT 1");
  api.viewTable.mockResolvedValue({
    columns: [],
    rows: [],
    affected_rows: 0,
    execution_ms: 1,
    truncated: false,
    source: { database: "app", table, primary_keys: [] },
  });
  render(<App />);
  const database = within(screen.getByRole("complementary")).getByRole(
    "button",
    { name: "app" },
  );
  fireEvent.click(database);
  const list = await screen.findByRole("table", { name: "Table list for app" });
  fireEvent.doubleClick(
    within(list).getByRole("button", { name: "customers" }),
  );
  await waitFor(() => expect(api.viewTable).toHaveBeenCalled());
  expect(
    useWorkspace
      .getState()
      .tabs.find((t) => t.id === useWorkspace.getState().activeTab)
      ?.tableIdentity?.name,
  ).toBe("customers");
  fireEvent.click(database);
  fireEvent.click(screen.getByRole("button", { name: "New Table" }));
  expect(await screen.findByRole("dialog", { name: /New Table/ })).toBeTruthy();
});

it("refreshes database list metadata and offers retry after failure", async () => {
  workspace("SELECT 1");
  api.schema.mockRejectedValueOnce(new Error("Metadata unavailable"));
  render(<App />);
  fireEvent.click(
    within(screen.getByRole("complementary")).getByRole("button", {
      name: "app",
    }),
  );
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh database tables" }),
  );
  expect(await screen.findByText(/Metadata unavailable/)).toBeTruthy();
  api.schema.mockResolvedValue({
    database: "app",
    tables: [table, { name: "orders", schema: "public", kind: "view" }],
  });
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  const list = await screen.findByRole("table", { name: "Table list for app" });
  expect(
    await within(list).findByRole("button", { name: "orders" }),
  ).toBeTruthy();
  expect(within(list).getByText("View")).toBeTruthy();
  expect(api.schema).toHaveBeenCalledWith("pg", "app");
});

function multipleTabs() {
  workspace("SELECT 1");
  const first = useWorkspace.getState().tabs[0];
  useWorkspace.setState({
    tabs: [
      first,
      { ...first, id: "tab-2", name: "Second" },
      { ...first, id: "tab-3", name: "Third" },
    ],
  });
}
it("disables moving database-list tabs to a new window", async () => {
  workspace("SELECT 1");
  render(<App />);
  fireEvent.click(
    within(screen.getByRole("complementary")).getByRole("button", {
      name: "app",
    }),
  );
  fireEvent.contextMenu(screen.getByRole("tab", { name: "app" }));
  const move = screen.getByRole("menuitem", { name: "Move Tab to New Window" });
  expect(move.hasAttribute("disabled")).toBe(true);
  fireEvent.click(move);
  expect(api.moveTabToWindow).not.toHaveBeenCalled();
});
function tabMenu(name: string) {
  fireEvent.contextMenu(screen.getByRole("tab", { name }), {
    clientX: 150,
    clientY: 100,
  });
  return screen.getByRole("menu", { name: `${name} tab actions` });
}
it("closes tabs to the right in their displayed order", async () => {
  multipleTabs();
  render(<App />);
  let menu = tabMenu("Third");
  expect(
    within(menu)
      .getByRole("menuitem", { name: "Close Tabs to the Right" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.keyDown(menu, { key: "Escape" });
  menu = tabMenu("Second");
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: "Close Tabs to the Right" }),
  );
  await waitFor(() =>
    expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toEqual([
      "tab-1",
      "tab-2",
    ]),
  );
  expect(useWorkspace.getState().activeTab).toBe("tab-2");
  expect(api.closeSession).toHaveBeenCalledWith("pg", "tab-3");
});
it("does not close any tab when a bulk discard or transaction confirmation is cancelled", async () => {
  multipleTabs();
  useWorkspace.getState().updateTab("tab-2", {
    staged: {
      edits: { "[1]": { key: { id: 1 }, values: { name: "Pending" } } },
      deletes: {},
      drafts: [],
      transaction: false,
    },
  });
  render(<App />);
  fireEvent.click(
    within(tabMenu("Cleanup")).getByRole("menuitem", {
      name: "Close Other Tabs",
    }),
  );
  const confirmation = await screen.findByRole("alertdialog");
  fireEvent.click(within(confirmation).getByRole("button", { name: "Cancel" }));
  expect(useWorkspace.getState().tabs).toHaveLength(3);
  expect(api.closeSession).not.toHaveBeenCalled();
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  useWorkspace.getState().updateTab("tab-2", { staged: undefined });
  api.sessionInTransaction.mockResolvedValue(true);
  fireEvent.click(
    within(tabMenu("Cleanup")).getByRole("menuitem", {
      name: "Close Other Tabs",
    }),
  );
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Cancel",
    }),
  );
  expect(useWorkspace.getState().tabs).toHaveLength(3);
  expect(api.closeSession).not.toHaveBeenCalled();
});
it("disables bulk close when it includes a running tab and closes all after confirmation", async () => {
  multipleTabs();
  useWorkspace.getState().updateTab("tab-3", { running: true });
  render(<App />);
  let menu = tabMenu("Cleanup");
  expect(
    within(menu)
      .getByRole("menuitem", { name: "Close All" })
      .hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.keyDown(menu, { key: "Escape" });
  useWorkspace.getState().updateTab("tab-3", { running: false });
  menu = tabMenu("Cleanup");
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Close All" }));
  await waitFor(() => expect(useWorkspace.getState().tabs).toHaveLength(0));
  expect(api.closeSession).toHaveBeenCalledTimes(3);
});
it("adds a query favorite and reactivates its existing tab", async () => {
  workspace("SELECT 1");
  render(<App />);
  fireEvent.click(
    within(tabMenu("Cleanup")).getByRole("menuitem", {
      name: "Add to Favorites",
    }),
  );
  const sidebar = screen.getByRole("complementary");
  expect(await within(sidebar).findByText("FAVORITES")).toBeTruthy();
  fireEvent.click(within(sidebar).getByRole("button", { name: "Cleanup" }));
  expect(useWorkspace.getState().tabs).toHaveLength(1);
  expect(JSON.parse(localStorage.getItem("dbde.tab-favorites")!)[0].query).toBe(
    "SELECT 1",
  );
  fireEvent.click(
    within(tabMenu("Cleanup")).getByRole("menuitem", {
      name: "Remove from Favorites",
    }),
  );
  expect(within(sidebar).queryByText("FAVORITES")).toBeNull();
});
it("reveals a table tab in the navigation pane, clearing the sidebar filter", async () => {
  workspace("SELECT 1");
  useWorkspace.getState().updateTab("tab-1", {
    tableIdentity: { database: "app", schema: "public", name: "customers" },
  });
  render(<App />);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Find database or table" }),
    { target: { value: "missing" } },
  );
  fireEvent.click(
    within(tabMenu("Cleanup")).getByRole("menuitem", {
      name: "Reveal in Navigation Pane",
    }),
  );
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(screen.getByRole("complementary")).getByRole("button", {
        name: "customers",
      }),
    ),
  );
  expect(
    (
      screen.getByRole("textbox", {
        name: "Find database or table",
      }) as HTMLInputElement
    ).value,
  ).toBe("");
});
it("retains the original tab when moving fails, then transfers it without closing its SQL session", async () => {
  workspace("SELECT 1");
  api.moveTabToWindow.mockRejectedValueOnce(
    new Error("Window initialization failed"),
  );
  render(<App />);
  fireEvent.click(
    within(tabMenu("Cleanup")).getByRole("menuitem", {
      name: "Move Tab to New Window",
    }),
  );
  expect(await screen.findByText(/Window initialization failed/)).toBeTruthy();
  expect(useWorkspace.getState().tabs).toHaveLength(1);
  expect(useWorkspace.getState().tabs[0].running).toBe(false);
  api.moveTabToWindow.mockResolvedValueOnce(undefined);
  fireEvent.click(
    within(tabMenu("Cleanup")).getByRole("menuitem", {
      name: "Move Tab to New Window",
    }),
  );
  await waitFor(() => expect(useWorkspace.getState().tabs).toHaveLength(0));
  expect(api.closeSession).not.toHaveBeenCalled();
  expect(api.sessionInTransaction).not.toHaveBeenCalled();
});

it("locks detached windows to one focused tab without sidebar or tab creation controls", async () => {
  workspace("SELECT 1");
  useWorkspace.getState().updateTab("tab-1", {
    tableIdentity: { database: "app", schema: "public", name: "customers" },
    editorOpen: true,
  });
  window.history.replaceState(null, "", "#detached");
  useWorkspace.setState({ singleTab: true });
  try {
    const view = render(<App />);
    await waitFor(() =>
      expect(api.guardDetachedWindowClose).toHaveBeenCalled(),
    );
    expect(
      view.container.querySelector(".app")?.classList.contains("table-focused"),
    ).toBe(true);
    expect(
      view.container.querySelector("#sql-editor-panel")?.hasAttribute("hidden"),
    ).toBe(true);
    expect(screen.queryByRole("complementary")).toBeNull();
    expect(screen.queryByRole("button", { name: "Show explorer" })).toBeNull();
    expect(screen.queryByRole("button", { name: "New query tab" })).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Show SQL editor" }),
    ).toBeNull();
    expect(
      screen.queryByRole("button", { name: "Exit table focus" }),
    ).toBeNull();
    useWorkspace.getState().addTab("pg", "SELECT 2");
    useWorkspace.getState().openDatabaseTab("pg", "other");
    expect(useWorkspace.getState().tabs).toHaveLength(1);
    expect(screen.queryByRole("tablist")).toBeNull();
    expect(view.container.querySelector(".titlebar")).toBeNull();
    expect(view.container.querySelector(".statusbar")).toBeNull();
    const toolbar = screen.getByRole("toolbar", {
      name: "Focused table actions",
    });
    fireEvent.contextMenu(toolbar, { clientX: 20, clientY: 20 });
    const menu = screen.getByRole("menu", { name: "Cleanup tab actions" });
    expect(
      within(menu)
        .getByRole("menuitem", { name: "Reveal in Navigation Pane" })
        .hasAttribute("disabled"),
    ).toBe(true);
    expect(
      within(menu)
        .getByRole("menuitem", { name: "Move Tab to New Window" })
        .hasAttribute("disabled"),
    ).toBe(true);
    fireEvent.keyDown(menu, { key: "Escape" });
    expect(document.activeElement).toBe(toolbar);
    fireEvent.keyDown(toolbar, { key: "w", ctrlKey: true });
    await waitFor(() => expect(api.closeDetachedWindow).toHaveBeenCalled());
  } finally {
    useWorkspace.setState({ singleTab: false });
    window.history.replaceState(null, "", window.location.pathname);
  }
});

it("runs only the selected MySQL Flush command, on a separate pooled query", async () => {
  workspace("SELECT 1");
  useWorkspace
    .getState()
    .updateSession("pg", { config: { ...config, driver: "mysql" } });
  render(<App />);
  await connectionMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Flush" }));
  fireEvent.click(screen.getByRole("menuitem", { name: "Privileges" }));
  await waitFor(() =>
    expect(api.execute).toHaveBeenCalledWith("pg", "FLUSH PRIVILEGES;", "app"),
  );
  expect(useWorkspace.getState().tabs[0].id).toBe("tab-1");
});

it("keeps the old connection open if switching profiles fails authentication", async () => {
  workspace("SELECT 1");
  const other = {
    ...config,
    id: "other-profile",
    name: "Other server",
    host: "other.example",
  };
  api.listProfiles.mockResolvedValue([config, other]);
  api.connect.mockRejectedValue(new Error("Login failed"));
  render(<App />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Remove Other server" }),
    ).toBeTruthy(),
  );
  await connectionMenu();
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Switch Connection Profile" }),
  );
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Other server" }));
  await screen.findByText(/Login failed/);
  expect(api.disconnect).not.toHaveBeenCalled();
  expect(useWorkspace.getState().sessions[0].id).toBe("pg");
  expect(useWorkspace.getState().tabs[0].id).toBe("tab-1");
});
it("switches to an already open profile without discarding that profile's tabs", async () => {
  workspace("SELECT 1");
  const other = {
    ...config,
    id: "other-profile",
    name: "Other server",
    host: "other.example",
  };
  useWorkspace
    .getState()
    .addSession({ id: "other-session", config: other, databases: ["app"] });
  useWorkspace
    .getState()
    .addTab("other-session", "SELECT 'kept'", "Kept", "app");
  const kept = useWorkspace.getState().activeTab;
  api.listProfiles.mockResolvedValue([config, other]);
  api.connect.mockResolvedValue("other-session");
  render(<App />);
  await waitFor(() =>
    expect(
      screen.getByRole("button", { name: "Remove Other server" }),
    ).toBeTruthy(),
  );
  await connectionMenu();
  fireEvent.click(
    screen.getByRole("menuitem", { name: "Switch Connection Profile" }),
  );
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Other server" }));
  await waitFor(() =>
    expect(useWorkspace.getState().sessions.map((s) => s.id)).toEqual([
      "other-session",
    ]),
  );
  expect(useWorkspace.getState().activeTab).toBe(kept);
  expect(useWorkspace.getState().tabs.find((t) => t.id === kept)?.query).toBe(
    "SELECT 'kept'",
  );
  expect(api.disconnect).toHaveBeenCalledWith("pg");
  expect(api.disconnect).not.toHaveBeenCalledWith("other-session");
});
it("does not disconnect or delete a connection while its query is running", async () => {
  workspace("SELECT 1");
  useWorkspace.getState().updateTab("tab-1", { running: true });
  render(<App />);
  await connectionMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: /^Close Connection/ }));
  await screen.findByText(/Wait for running queries to finish/);
  expect(api.disconnect).not.toHaveBeenCalled();
  expect(useWorkspace.getState().sessions[0].id).toBe("pg");
});
it("shares a focused connection without exporting passwords", async () => {
  workspace("SELECT 1");
  useWorkspace.getState().updateSession("pg", {
    config: { ...config, database_only: true, password: "secret-local-only" },
  });
  render(<App />);
  await connectionMenu();
  fireEvent.click(screen.getByRole("menuitem", { name: "Share…" }));
  await screen.findByRole("dialog", { name: "Share Connection" });
  const value = (
    screen.getByRole("textbox", {
      name: "Connection profile without password",
    }) as HTMLTextAreaElement
  ).value;
  expect(value).not.toMatch(/password|secret-local-only/);
  expect(JSON.parse(value).connection.database_only).toBe(true);
});

it("opens the connection menu by right click or Shift F10 and returns focus on Escape", async () => {
  workspace("SELECT 1");
  render(<App />);
  const heading = screen.getByRole("button", {
    name: "Actions for connection Postgres",
  }).parentElement!;
  const trigger = heading.querySelector("button")!;
  expect(fireEvent.contextMenu(heading, { clientX: 12, clientY: 18 })).toBe(
    false,
  );
  const menu = screen.getByRole("menu", {
    name: "Postgres connection actions",
  });
  expect(document.activeElement).toBe(
    within(menu).getByRole("menuitem", { name: /^Close Connection/ }),
  );
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(
    screen.queryByRole("menu", { name: "Postgres connection actions" }),
  ).toBeNull();
  expect(document.activeElement).toBe(trigger);
  fireEvent.keyDown(trigger, { key: "F10", shiftKey: true });
  expect(
    screen.getByRole("menu", { name: "Postgres connection actions" }),
  ).toBeTruthy();
});

it("shows only custom databases and expands only databases marked Auto Open", async () => {
  workspace("SELECT 1");
  const profile = {
    ...config,
    id: "custom-profile",
    name: "Custom display",
    options: {
      auto_connect: true,
      custom_database_list: true,
      database_list: [
        { name: "app", auto_open: false },
        { name: "warehouse", auto_open: true },
      ],
    },
  };
  api.listProfiles.mockResolvedValue([profile]);
  api.schema.mockImplementation(async (_id: string, database: string) => ({
    database,
    tables: [],
  }));
  render(<App />);
  await waitFor(() =>
    expect(
      useWorkspace
        .getState()
        .sessions.find((session) => session.id === "replacement")?.databases,
    ).toEqual(["app", "warehouse"]),
  );
  await waitFor(() =>
    expect(api.schema).toHaveBeenCalledWith("replacement", "warehouse"),
  );
  expect(api.schema).not.toHaveBeenCalledWith("replacement", "app");
});
it("preserves pending grid changes when running SQL is cancelled", async () => {
  workspace("SELECT 2");
  useWorkspace.getState().updateTab("tab-1", {
    staged: {
      edits: { "[1]": { key: { id: 1 }, values: { name: "unsaved" } } },
      deletes: {},
      drafts: [],
      transaction: true,
    },
  });
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
  const prompt = await screen.findByRole("alertdialog");
  expect(
    within(prompt).getByText("Discard unsaved table changes?"),
  ).toBeTruthy();
  fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
  expect(api.execute).not.toHaveBeenCalled();
  expect(
    useWorkspace.getState().tabs[0].staged?.edits["[1]"]?.values.name,
  ).toBe("unsaved");
  fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Discard changes",
    }),
  );
  await waitFor(() => expect(api.execute).toHaveBeenCalled());
  expect(useWorkspace.getState().tabs[0].staged).toBeUndefined();
});

it("copies a table from one database list and pastes it into another database after review", async () => {
  workspace("SELECT 1");
  const mysqlTable = { name: "customers", schema: "app", kind: "table" };
  const mysqlConfig = {
    ...config,
    driver: "mysql" as const,
    port: 3306,
    database_only: true,
  };
  useWorkspace.getState().updateSession("pg", {
    config: mysqlConfig,
    trees: { app: { database: "app", tables: [mysqlTable] } },
  });
  useWorkspace.getState().addSession({
    id: "target",
    config: {
      ...mysqlConfig,
      id: "target-profile",
      name: "Target",
      database: "other",
    },
    databases: ["other"],
    trees: { other: { database: "other", tables: [] } },
  });
  const writeText = vi.fn().mockResolvedValue(undefined);
  vi.stubGlobal("navigator", {
    platform: "MacIntel",
    userAgent: navigator.userAgent,
    clipboard: { writeText, readText: vi.fn().mockResolvedValue("customers") },
  });
  api.schema.mockImplementation(async (_id: string, database: string) => ({
    database,
    tables: database === "app" ? [mysqlTable] : [],
  }));
  api.pasteTable.mockResolvedValue(undefined);
  render(<App />);
  fireEvent.click(
    within(screen.getByRole("complementary")).getByRole("button", {
      name: "app",
    }),
  );
  const row = within(
    await screen.findByRole("table", { name: "Table list for app" }),
  ).getByRole("button", { name: "customers" });
  fireEvent.click(row);
  fireEvent.keyDown(row, { key: "c", metaKey: true });
  await waitFor(() => expect(writeText).toHaveBeenCalledWith("customers"));
  expect(api.pasteTable).not.toHaveBeenCalled();
  fireEvent.click(
    within(screen.getByRole("complementary")).getByRole("button", {
      name: "other",
    }),
  );
  const targetList = await screen.findByRole("table", {
    name: "Table list for other",
  });
  fireEvent.keyDown(targetList, { key: "v", metaKey: true });
  const dialog = await screen.findByRole("dialog", { name: "Paste tables" });
  await within(dialog).findByRole("textbox", {
    name: "Target name for customers",
  });
  expect(api.pasteTable).not.toHaveBeenCalled();
  fireEvent.click(within(dialog).getByRole("button", { name: "Paste tables" }));
  await waitFor(() =>
    expect(api.pasteTable).toHaveBeenCalledWith(
      "pg",
      "app",
      mysqlTable,
      "target",
      "other",
      { name: "customers", schema: "other", kind: "table" },
      true,
    ),
  );
  await waitFor(() =>
    expect(screen.queryByRole("dialog", { name: "Paste tables" })).toBeNull(),
  );
  expect(
    useWorkspace.getState().sessions.find((session) => session.id === "pg")
      ?.trees?.app.tables,
  ).toEqual([mysqlTable]);
});

describe("renaming a table", () => {
  it("renames from the table menu and moves open tabs and pinned shortcuts", async () => {
    workspace("SELECT 1");
    const source = { database: "app", table, primary_keys: ["id"] };
    useWorkspace.setState((state) => ({
      tabs: [
        ...state.tabs,
        {
          id: "tab-2",
          name: "customers",
          connectionId: "pg",
          database: "app",
          query: "SELECT 1",
          running: false,
          tableIdentity: {
            database: "app",
            schema: "public",
            name: "customers",
          },
          result: {
            columns: ["id"],
            rows: [[1]],
            affected_rows: 0,
            execution_ms: 0,
            truncated: false,
            source,
          },
        },
      ],
    }));
    localStorage.setItem(
      "dbde.table-shortcuts",
      JSON.stringify([{ profile_id: "pg", database: "app", table }]),
    );
    const renamed = { ...table, name: "clients" };
    api.renameTable.mockResolvedValue(renamed);
    api.viewTable.mockResolvedValue({
      columns: ["id"],
      rows: [[1]],
      affected_rows: 0,
      execution_ms: 0,
      truncated: false,
      source: { ...source, table: renamed },
    });
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for customers" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    const dialog = await screen.findByRole("dialog", {
      name: /Rename table customers/,
    });
    const input = within(dialog).getByRole("textbox", { name: "New name" });
    fireEvent.change(input, { target: { value: "clients" } });
    expect(within(dialog).getByLabelText("SQL to run").textContent).toBe(
      'ALTER TABLE "public"."customers" RENAME TO "clients";',
    );
    expect(
      within(dialog).getByText(/follow the rename automatically/),
    ).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    await waitFor(() =>
      expect(api.renameTable).toHaveBeenCalledWith(
        "pg",
        "app",
        table,
        "clients",
      ),
    );
    await waitFor(() =>
      expect(screen.queryByRole("dialog", { name: /Rename table/ })).toBeNull(),
    );
    const moved = useWorkspace.getState().tabs.find((t) => t.id === "tab-2")!;
    expect(moved.name).toBe("clients");
    expect(moved.tableIdentity?.name).toBe("clients");
    await waitFor(() =>
      expect(api.viewTable).toHaveBeenCalledWith(
        "pg",
        "app",
        renamed,
        1,
        1000,
        [],
        undefined,
        false,
      ),
    );
    await waitFor(() =>
      expect(JSON.parse(localStorage.getItem("dbde.table-shortcuts")!)).toEqual(
        [{ profile_id: "pg", database: "app", table: renamed }],
      ),
    );
    expect(
      await screen.findByText("Renamed customers to clients."),
    ).toBeTruthy();
  });
  it("keeps the dialog open with the reason when the rename is refused", async () => {
    workspace("SELECT 1");
    api.renameTable.mockRejectedValue(
      new Error('relation "clients" already exists'),
    );
    render(<App />);
    fireEvent.click(
      screen.getByRole("button", { name: "Actions for customers" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    const dialog = await screen.findByRole("dialog", { name: /Rename table/ });
    fireEvent.change(
      within(dialog).getByRole("textbox", { name: "New name" }),
      {
        target: { value: "clients" },
      },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: "Rename" }));
    expect((await within(dialog).findByRole("alert")).textContent).toContain(
      "already exists",
    );
  });
  it("opens the rename dialog with F2 in the table list", async () => {
    workspace("SELECT 1");
    render(<App />);
    fireEvent.click(
      within(screen.getByRole("complementary")).getByRole("button", {
        name: "app",
      }),
    );
    const list = await screen.findByRole("table", {
      name: "Table list for app",
    });
    const customer = within(list).getByRole("button", { name: "customers" });
    customer.focus();
    fireEvent.click(customer);
    fireEvent.keyDown(customer, { key: "F2" });
    expect(
      await screen.findByRole("dialog", { name: /Rename table customers/ }),
    ).toBeTruthy();
  });
});

describe("explain and maintain wiring", () => {
  const plan = {
    format: "json",
    sql: "EXPLAIN (FORMAT JSON) SELECT * FROM customers",
    raw: '[{"Plan": {"Node Type": "Seq Scan", "Relation Name": "customers", "Alias": "customers", "Total Cost": 12.5, "Plan Rows": 250}}]',
    columns: [],
    rows: [],
    analyzed: false,
    rolled_back: false,
    server_version: "",
    execution_ms: 2,
  };
  const useDriver = (driver: "mysql" | "postgres") =>
    useWorkspace.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        config: { ...session.config, driver },
      })),
    }));
  it("explains only a single statement on the tab's session and shows the plan view", async () => {
    workspace("SELECT 1; SELECT 2;");
    api.explain.mockResolvedValue(plan);
    render(<App />);
    fireEvent.click(screen.getByRole("button", { name: /Explain/ }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "several statements",
    );
    expect(api.explain).not.toHaveBeenCalled();
    act(() =>
      useWorkspace
        .getState()
        .updateTab("tab-1", { query: "SELECT * FROM customers;" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Explain/ }));
    await waitFor(() =>
      expect(api.explain).toHaveBeenCalledWith(
        "pg",
        "SELECT * FROM customers",
        "app",
        "tab-1",
        false,
        false,
        600,
      ),
    );
    const view = await screen.findByRole("region", { name: "Query plan" });
    expect(
      within(view).getByRole("list", { name: "Plan warnings" }).textContent,
    ).toContain("Full table scan on customers");
    expect(api.execute).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("tab", { name: /Results/ }));
    expect(screen.queryByRole("region", { name: "Query plan" })).toBeNull();
    fireEvent.click(screen.getByRole("tab", { name: /Plan/ }));
    expect(screen.getByRole("region", { name: "Query plan" })).toBeTruthy();
  });
  it("asks before EXPLAIN ANALYZE runs a write and only then allows it", async () => {
    workspace("DELETE FROM customers WHERE id = 1");
    api.explain.mockResolvedValue({
      ...plan,
      analyzed: true,
      rolled_back: true,
    });
    render(<App />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Analyze" }));
    fireEvent.click(screen.getByRole("button", { name: /Explain/ }));
    const prompt = await screen.findByRole("alertdialog");
    expect(
      within(prompt).getByText(
        "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) DELETE FROM customers WHERE id = 1",
      ),
    ).toBeTruthy();
    fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
    expect(api.explain).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    fireEvent.click(screen.getByRole("button", { name: /Explain/ }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Analyze and roll back",
      }),
    );
    await waitFor(() =>
      expect(api.explain).toHaveBeenCalledWith(
        "pg",
        "DELETE FROM customers WHERE id = 1",
        "app",
        "tab-1",
        true,
        true,
        600,
      ),
    );
    expect(await screen.findByText("Analyzed · rolled back")).toBeTruthy();
  });
  it("analyzes MySQL reads without a prompt and refuses MySQL write analysis", async () => {
    workspace("UPDATE customers SET plan = 'Pro' WHERE id = 1");
    useDriver("mysql");
    api.explain.mockResolvedValue({ ...plan, analyzed: true });
    render(<App />);
    fireEvent.click(screen.getByRole("checkbox", { name: "Analyze" }));
    fireEvent.click(screen.getByRole("button", { name: /Explain/ }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "cannot reliably roll writes back",
    );
    expect(api.explain).not.toHaveBeenCalled();
    act(() =>
      useWorkspace
        .getState()
        .updateTab("tab-1", { query: "SELECT * FROM customers" }),
    );
    fireEvent.click(screen.getByRole("button", { name: /Explain/ }));
    await waitFor(() =>
      expect(api.explain).toHaveBeenCalledWith(
        "pg",
        "SELECT * FROM customers",
        "app",
        "tab-1",
        true,
        false,
        600,
      ),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
  });
  const result = {
    statements: ['VACUUM FULL "public"."customers"'],
    rows: [
      {
        table: "public.customers",
        op: "vacuum full",
        msg_type: "status",
        msg_text: "OK (4 ms)",
      },
    ],
    execution_ms: 4,
  };
  async function openTableMenu() {
    fireEvent.click(
      within(screen.getByRole("complementary")).getByRole("button", {
        name: "app",
      }),
    );
    const list = await screen.findByRole("table", {
      name: "Table list for app",
    });
    return list;
  }
  it("confirms a locking maintenance with its SQL, rolls back app transactions and shows the results", async () => {
    workspace("BEGIN;");
    api.sessionInTransaction.mockResolvedValue(true);
    api.maintainTables.mockResolvedValue(result);
    render(<App />);
    const list = await openTableMenu();
    fireEvent.contextMenu(
      within(list).getByRole("button", { name: "customers" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Maintain/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Vacuum Full…" }));
    let prompt = await screen.findByRole("alertdialog");
    expect(
      within(prompt).getByText('VACUUM FULL "public"."customers"'),
    ).toBeTruthy();
    expect(prompt.textContent).toContain("ACCESS EXCLUSIVE");
    fireEvent.click(
      within(prompt).getByRole("button", { name: "Run Vacuum Full" }),
    );
    // The query tab holds an open transaction that VACUUM FULL would wait on.
    await waitFor(() =>
      expect(screen.getByRole("alertdialog").textContent).toContain(
        "Roll back the open transaction?",
      ),
    );
    prompt = screen.getByRole("alertdialog");
    fireEvent.click(
      within(prompt).getByRole("button", { name: "Roll back and continue" }),
    );
    await waitFor(() =>
      expect(api.maintainTables).toHaveBeenCalledWith(
        "pg",
        "app",
        [table],
        "vacuum-full",
        600,
      ),
    );
    expect(api.closeSession).toHaveBeenCalledWith("pg", "tab-1");
    expect(api.closeSession.mock.invocationCallOrder[0]).toBeLessThan(
      api.maintainTables.mock.invocationCallOrder[0],
    );
    const dialog = await screen.findByRole("dialog", {
      name: /Vacuum Full results/,
    });
    expect(within(dialog).getByText("OK (4 ms)")).toBeTruthy();
    fireEvent.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(
      screen.queryByRole("dialog", { name: /Vacuum Full results/ }),
    ).toBeNull();
  });
  it("does not run a locking maintenance when its confirmation is cancelled", async () => {
    workspace("SELECT 1");
    render(<App />);
    const list = await openTableMenu();
    fireEvent.contextMenu(
      within(list).getByRole("button", { name: "customers" }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: /Maintain/ }));
    fireEvent.click(screen.getByRole("menuitem", { name: "Reindex…" }));
    fireEvent.click(
      within(await screen.findByRole("alertdialog")).getByRole("button", {
        name: "Cancel",
      }),
    );
    await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
    expect(api.maintainTables).not.toHaveBeenCalled();
    expect(api.closeSession).not.toHaveBeenCalled();
  });
  it("maintains every selected table at once without prompting for non-locking operations", async () => {
    workspace("SELECT 1");
    const orders = { name: "orders", schema: "public", kind: "table" };
    useWorkspace.setState((state) => ({
      sessions: state.sessions.map((session) => ({
        ...session,
        trees: { app: { database: "app", tables: [table, orders] } },
      })),
    }));
    api.maintainTables.mockResolvedValue({ ...result, statements: [] });
    render(<App />);
    const list = await openTableMenu();
    fireEvent.click(
      within(list).getByRole("button", { name: "customers" }).closest("tr")!,
    );
    fireEvent.click(
      within(list).getByRole("button", { name: "orders" }).closest("tr")!,
      {
        ctrlKey: true,
        metaKey: true,
      },
    );
    fireEvent.contextMenu(within(list).getByRole("button", { name: "orders" }));
    fireEvent.click(
      screen.getByRole("menuitem", { name: /Maintain \(2 tables\)/ }),
    );
    fireEvent.click(screen.getByRole("menuitem", { name: "Analyze" }));
    await waitFor(() =>
      expect(api.maintainTables).toHaveBeenCalledWith(
        "pg",
        "app",
        [table, orders],
        "analyze",
        undefined,
      ),
    );
    expect(screen.queryByRole("alertdialog")).toBeNull();
    expect(api.sessionInTransaction).not.toHaveBeenCalled();
  });
});

it.each(["metaKey", "ctrlKey"] as const)(
  "opens design immediately after opening a sidebar table with %s+D",
  async (modifier) => {
    workspace("SELECT 1");
    api.viewTable.mockResolvedValue({
      columns: ["id"],
      rows: [[1]],
      affected_rows: 0,
      execution_ms: 1,
      truncated: false,
      source: { database: "app", table, primary_keys: ["id"] },
    });
    api.columns.mockResolvedValue([
      { name: "id", data_type: "integer", nullable: false },
    ]);
    api.tableDdl.mockResolvedValue(
      "CREATE TABLE customers (id integer PRIMARY KEY);",
    );
    render(<App />);
    const button = within(screen.getByRole("complementary")).getByRole(
      "button",
      { name: "customers" },
    );
    button.focus();
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        useWorkspace
          .getState()
          .tabs.find((t) => t.id === useWorkspace.getState().activeTab)?.result
          ?.source,
      ).toBeTruthy(),
    );
    expect(document.activeElement).toBe(button);
    fireEvent.keyDown(button, { key: "d", [modifier]: true });
    expect(
      await screen.findByRole("button", { name: "Close table design" }),
    ).toBeTruthy();
  },
);

it("opens active table design when focus returns to the page after a table list closes", async () => {
  workspace("SELECT 1");
  useWorkspace.getState().updateTab("tab-1", {
    result: {
      columns: ["id"],
      rows: [[1]],
      affected_rows: 0,
      execution_ms: 1,
      truncated: false,
      source: { database: "app", table, primary_keys: ["id"] },
    },
  });
  api.tableDdl.mockResolvedValue(
    "CREATE TABLE customers (id integer PRIMARY KEY);",
  );
  render(<App />);
  fireEvent.keyDown(document.body, { key: "d", metaKey: true });
  expect(
    await screen.findByRole("button", { name: "Close table design" }),
  ).toBeTruthy();
});
