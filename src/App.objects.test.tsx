// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
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
import type { ConnectionConfig, DbObject, Driver } from "./types";
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
  listObjects: vi.fn(),
  objectDefinition: vi.fn(),
  objectAction: vi.fn(),
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
function workspace(driver: Driver = "postgres") {
  const config: ConnectionConfig = {
    id: "srv",
    name: "Server",
    driver,
    host: "db.example",
    port: driver === "mysql" ? 3306 : 5432,
    username: "app",
    database: "app",
    file_path: "",
    ssl_mode: "verify-full",
  };
  useWorkspace.setState({
    singleTab: false,
    sessions: [
      {
        id: "srv",
        config,
        databases: ["app"],
        trees: {
          app: {
            database: "app",
            tables: [
              {
                name: "customers",
                schema: driver === "postgres" ? "public" : "app",
                kind: "table",
              },
            ],
          },
        },
      },
    ],
    tabs: [
      {
        id: "tab-1",
        name: "Query",
        connectionId: "srv",
        database: "app",
        query: "SELECT 1",
        running: false,
      },
    ],
    activeTab: "tab-1",
  });
}
const fn: DbObject = {
  kind: "function",
  schema: "app",
  name: "total",
  signature: "integer, text",
  detail: "RETURNS integer · plpgsql",
};
const sidebar = () => screen.getByRole("complementary");
async function expandGroup(name: string) {
  fireEvent.click(within(sidebar()).getByRole("button", { name }));
}
async function openMenu(label: string) {
  fireEvent.click(
    await within(sidebar()).findByRole("button", {
      name: `Actions for ${label}`,
    }),
  );
  return screen.findByRole("menu", { name: `${label} actions` });
}
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
  api.listDatabases.mockResolvedValue(["app"]);
  api.schema.mockResolvedValue({ database: "app", tables: [] });
  api.listProfiles.mockResolvedValue([]);
  api.guardDetachedWindowClose.mockResolvedValue(() => {});
  api.listIndexes.mockResolvedValue([]);
  api.columns.mockResolvedValue([]);
  api.listObjects.mockImplementation(
    async (_id: string, _db: string, kind: string) =>
      kind === "function" ? [fn] : [],
  );
  api.objectDefinition.mockResolvedValue({
    definition:
      "CREATE OR REPLACE FUNCTION app.total(a integer, b text) RETURNS integer;",
    edit_script:
      "-- CREATE OR REPLACE keeps grants\nCREATE OR REPLACE FUNCTION app.total(a integer, b text) RETURNS integer;\n",
    execute_script:
      'SELECT * FROM "app"."total"(\n  NULL::integer /* a */\n);\n',
  });
  api.objectAction.mockImplementation(
    async (
      _id: string,
      _db: string,
      object: DbObject,
      action: string,
      options: { value?: string } = {},
    ) =>
      action === "drop"
        ? `DROP FUNCTION "${object.schema}"."${object.name}"(${object.signature})`
        : action === "restart"
          ? `ALTER SEQUENCE "${object.schema}"."${object.name}" RESTART WITH ${options.value}`
          : `ALTER EVENT \`${object.name}\` ${action.toUpperCase()}`,
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("loads explorer object groups only when expanded and shows their counts", async () => {
  workspace();
  render(<App />);
  const group = within(sidebar()).getByRole("button", {
    name: "Functions in app",
  });
  expect(
    within(sidebar()).getByRole("button", { name: "Sequences in app" }),
  ).toBeTruthy();
  expect(
    within(sidebar()).queryByRole("button", { name: "Events in app" }),
  ).toBeNull();
  expect(api.listObjects).not.toHaveBeenCalled();
  expect(group.textContent).toContain("—");
  fireEvent.click(group);
  expect(
    await within(sidebar()).findByRole("button", {
      name: "total(integer, text)",
    }),
  ).toBeTruthy();
  expect(api.listObjects).toHaveBeenCalledTimes(1);
  expect(api.listObjects).toHaveBeenCalledWith("srv", "app", "function");
  expect(group.textContent).toContain("1");
  // Collapsing and expanding again reuses the cached list.
  fireEvent.click(group);
  fireEvent.click(group);
  expect(api.listObjects).toHaveBeenCalledTimes(1);
});

it("shows only triggers for SQLite and events for MySQL", async () => {
  workspace("mysql");
  render(<App />);
  expect(
    within(sidebar()).getByRole("button", { name: "Events in app" }),
  ).toBeTruthy();
  expect(
    within(sidebar()).queryByRole("button", { name: "Sequences in app" }),
  ).toBeNull();
  cleanup();
  workspace("sqlite");
  render(<App />);
  expect(
    within(sidebar()).getByRole("button", { name: "Triggers in app" }),
  ).toBeTruthy();
  expect(
    within(sidebar()).queryByRole("button", { name: "Functions in app" }),
  ).toBeNull();
});

it("views a definition read-only, then edits and executes it in new SQL tabs without running", async () => {
  workspace();
  render(<App />);
  await expandGroup("Functions in app");
  fireEvent.click(
    await within(sidebar()).findByRole("button", {
      name: "total(integer, text)",
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: /DDL · app\.total\(integer, text\)/,
  });
  expect(api.objectDefinition).toHaveBeenCalledWith("srv", "app", fn);
  expect(within(dialog).getByText(/function · read-only/)).toBeTruthy();
  expect(within(dialog).queryByText(/Triggers, comments, grants/)).toBeNull();
  expect(useWorkspace.getState().tabs).toHaveLength(1);
  fireEvent.click(within(dialog).getByRole("button", { name: "Close DDL" }));

  fireEvent.click(
    within(await openMenu("total(integer, text)")).getByRole("menuitem", {
      name: /Edit Function/,
    }),
  );
  await waitFor(() =>
    expect(
      useWorkspace.getState().tabs.find((t) => t.name === "Edit · total")
        ?.query,
    ).toBe(
      "-- CREATE OR REPLACE keeps grants\nCREATE OR REPLACE FUNCTION app.total(a integer, b text) RETURNS integer;\n",
    ),
  );
  fireEvent.click(
    within(await openMenu("total(integer, text)")).getByRole("menuitem", {
      name: "Execute…",
    }),
  );
  await waitFor(() =>
    expect(
      useWorkspace.getState().tabs.find((t) => t.name === "Execute · total")
        ?.query,
    ).toContain('SELECT * FROM "app"."total"('),
  );
  fireEvent.click(
    within(await openMenu("total(integer, text)")).getByRole("menuitem", {
      name: /New Function/,
    }),
  );
  await waitFor(() =>
    expect(
      useWorkspace.getState().tabs.find((t) => t.name === "New Function")
        ?.query,
    ).toMatch(/^CREATE OR REPLACE FUNCTION "public"\."new_function"/),
  );
  expect(api.execute).not.toHaveBeenCalled();
  expect(api.objectAction).not.toHaveBeenCalled();
});

it("confirms a drop with the exact signature SQL and refreshes the group", async () => {
  workspace();
  render(<App />);
  await expandGroup("Functions in app");
  fireEvent.click(
    within(await openMenu("total(integer, text)")).getByRole("menuitem", {
      name: /Drop Function/,
    }),
  );
  const prompt = await screen.findByRole("alertdialog");
  expect(
    within(prompt).getByText('DROP FUNCTION "app"."total"(integer, text)'),
  ).toBeTruthy();
  expect(api.objectAction).toHaveBeenCalledWith("srv", "app", fn, "drop", {
    value: undefined,
    preview: true,
  });
  fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(api.objectAction).toHaveBeenCalledTimes(1);

  api.listObjects.mockResolvedValue([]);
  fireEvent.click(
    within(await openMenu("total(integer, text)")).getByRole("menuitem", {
      name: /Drop Function/,
    }),
  );
  fireEvent.click(
    within(await screen.findByRole("alertdialog")).getByRole("button", {
      name: "Drop Function",
    }),
  );
  await waitFor(() =>
    expect(api.objectAction).toHaveBeenLastCalledWith(
      "srv",
      "app",
      fn,
      "drop",
      { value: undefined },
    ),
  );
  expect(await within(sidebar()).findByText("No functions.")).toBeTruthy();
  expect(api.listObjects).toHaveBeenCalledTimes(2);
});

it("enables a disabled MySQL event without a confirmation prompt", async () => {
  workspace("mysql");
  const event: DbObject = {
    kind: "event",
    schema: "app",
    name: "nightly",
    status: "DISABLED",
    detail: "EVERY 1 DAY",
  };
  api.listObjects.mockImplementation(
    async (_i: string, _d: string, kind: string) =>
      kind === "event" ? [event] : [],
  );
  render(<App />);
  await expandGroup("Events in app");
  const menu = await openMenu("nightly");
  expect(
    within(menu).queryByRole("menuitem", { name: "Disable Event" }),
  ).toBeNull();
  fireEvent.click(within(menu).getByRole("menuitem", { name: "Enable Event" }));
  await waitFor(() =>
    expect(api.objectAction).toHaveBeenLastCalledWith(
      "srv",
      "app",
      event,
      "enable",
      { value: undefined },
    ),
  );
  expect(screen.queryByRole("alertdialog")).toBeNull();
  await waitFor(() => expect(api.listObjects).toHaveBeenCalledTimes(2));
});

it("asks for a restart value and confirms the sequence reset SQL", async () => {
  workspace();
  const sequence: DbObject = {
    kind: "sequence",
    schema: "app",
    name: "ids",
    start: "1",
    increment: "1",
    last_value: "41",
  };
  api.listObjects.mockImplementation(
    async (_i: string, _d: string, kind: string) =>
      kind === "sequence" ? [sequence] : [],
  );
  render(<App />);
  await expandGroup("Sequences in app");
  fireEvent.click(
    within(await openMenu("ids")).getByRole("menuitem", {
      name: "Reset Sequence…",
    }),
  );
  const dialog = await screen.findByRole("dialog", {
    name: "Reset sequence app.ids",
  });
  expect(within(dialog).getByText("41")).toBeTruthy();
  const input = within(dialog).getByRole("textbox", { name: "Restart with" });
  fireEvent.change(input, { target: { value: "1.5" } });
  expect(
    (
      within(dialog).getByRole("button", {
        name: "Continue…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.change(input, { target: { value: "50" } });
  fireEvent.click(within(dialog).getByRole("button", { name: "Continue…" }));
  const prompt = await screen.findByRole("alertdialog");
  expect(
    within(prompt).getByText('ALTER SEQUENCE "app"."ids" RESTART WITH 50'),
  ).toBeTruthy();
  expect(api.objectAction).toHaveBeenCalledTimes(1);
  fireEvent.click(
    within(prompt).getByRole("button", { name: "Reset sequence" }),
  );
  await waitFor(() =>
    expect(api.objectAction).toHaveBeenLastCalledWith(
      "srv",
      "app",
      sequence,
      "restart",
      { value: "50" },
    ),
  );
});

it("keeps the database tab focused on tables while routines remain accessible in the sidebar", async () => {
  workspace();
  render(<App />);
  fireEvent.click(within(sidebar()).getByRole("button", { name: "app" }));
  expect(
    await screen.findByRole("table", { name: "Table list for app" }),
  ).toBeTruthy();
  expect(
    screen.queryByRole("tablist", { name: "Object types in app" }),
  ).toBeNull();
  expect(api.listObjects).not.toHaveBeenCalled();
  await expandGroup("Functions in app");
  expect(
    await within(sidebar()).findByRole("button", {
      name: "total(integer, text)",
    }),
  ).toBeTruthy();
  expect(api.listObjects).toHaveBeenCalledWith("srv", "app", "function");
  await expandGroup("Procedures in app");
  await waitFor(() =>
    expect(api.listObjects).toHaveBeenCalledWith("srv", "app", "procedure"),
  );
  expect(
    screen.getByRole("table", { name: "Table list for app" }),
  ).toBeTruthy();
});

it("reloads object lists after a CREATE runs in a SQL tab", async () => {
  workspace();
  render(<App />);
  await expandGroup("Functions in app");
  await within(sidebar()).findByRole("button", {
    name: "total(integer, text)",
  });
  act(() =>
    useWorkspace.getState().updateTab("tab-1", {
      query:
        "CREATE FUNCTION app.f() RETURNS int LANGUAGE sql AS $$ SELECT 1 $$",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
  await waitFor(() =>
    expect(api.execute.mock.calls[0]?.[1]).toMatch(/^CREATE FUNCTION/),
  );
  await waitFor(() => expect(api.listObjects).toHaveBeenCalledTimes(2));
});

it("opens materialized view data read-only and confirms a refresh with its SQL", async () => {
  workspace();
  const view: DbObject = {
    kind: "materialized_view",
    schema: "app",
    name: "totals",
    status: "POPULATED",
    refresh_concurrently: false,
  };
  api.listObjects.mockImplementation(
    async (_i: string, _d: string, kind: string) =>
      kind === "materialized_view" ? [view] : [],
  );
  api.viewTable.mockResolvedValue({
    columns: ["id"],
    rows: [[1]],
    affected_rows: 0,
    execution_ms: 1,
    truncated: false,
  });
  api.objectAction.mockResolvedValue(
    'REFRESH MATERIALIZED VIEW "app"."totals"',
  );
  render(<App />);
  await expandGroup("Materialized Views in app");
  fireEvent.click(
    await within(sidebar()).findByRole("button", { name: "totals" }),
  );
  await waitFor(() =>
    expect(api.viewTable).toHaveBeenCalledWith(
      "srv",
      "app",
      { name: "totals", schema: "app", kind: "view" },
      1,
      1000,
      [],
      undefined,
      false,
    ),
  );
  const menu = await openMenu("totals");
  expect(
    (
      within(menu).getByRole("menuitem", {
        name: "Refresh Concurrently…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  fireEvent.click(
    within(menu).getByRole("menuitem", { name: "Refresh Data…" }),
  );
  const prompt = await screen.findByRole("alertdialog");
  expect(
    within(prompt).getByText('REFRESH MATERIALIZED VIEW "app"."totals"'),
  ).toBeTruthy();
  fireEvent.click(within(prompt).getByRole("button", { name: "Refresh" }));
  await waitFor(() =>
    expect(api.objectAction).toHaveBeenLastCalledWith(
      "srv",
      "app",
      view,
      "refresh",
      { value: undefined },
    ),
  );
});

it("opens an explorer object's menu from the keyboard and returns focus on Escape", async () => {
  workspace();
  render(<App />);
  await expandGroup("Functions in app");
  const node = await within(sidebar()).findByRole("button", {
    name: "total(integer, text)",
  });
  node.focus();
  fireEvent.keyDown(node, { key: "F10", shiftKey: true });
  const menu = await screen.findByRole("menu", {
    name: "total(integer, text) actions",
  });
  expect(document.activeElement?.textContent).toContain("View Definition");
  fireEvent.keyDown(menu, { key: "Escape" });
  await waitFor(() =>
    expect(
      screen.queryByRole("menu", { name: "total(integer, text) actions" }),
    ).toBeNull(),
  );
  expect(document.activeElement).toBe(node);
});
