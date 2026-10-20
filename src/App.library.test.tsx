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
import type { ConnectionConfig } from "./types";
import type { SavedQuery } from "./lib/saved-queries";
const api = vi.hoisted(() => ({
  execute: vi.fn(),
  sessionInTransaction: vi.fn(),
  closeSession: vi.fn(),
  cancelQuery: vi.fn(),
  listProfiles: vi.fn(),
  connect: vi.fn(),
  schema: vi.fn(),
  columns: vi.fn(),
  listDatabases: vi.fn(),
  disconnect: vi.fn(),
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
  default: ({
    value,
    onSave,
    onSaveAs,
    snippets,
  }: {
    value: string;
    onSave?: () => void;
    onSaveAs?: () => void;
    snippets?: { prefix: string }[];
  }) => (
    <div>
      <textarea aria-label="SQL text" value={value} readOnly />
      <button onClick={onSave}>Editor Ctrl+S</button>
      <button onClick={onSaveAs}>Editor Ctrl+Shift+S</button>
      <span data-testid="snippet-prefixes">
        {snippets?.map((s) => s.prefix).join(",")}
      </span>
    </div>
  ),
}));
vi.mock("./lib/api", () => ({ desktop: true, ...api }));
const config: ConnectionConfig = {
  id: "profile-pg",
  name: "Postgres",
  driver: "postgres",
  host: "db.example",
  port: 5432,
  username: "app",
  database: "app",
  file_path: "",
  ssl_mode: "verify-full",
};
const saved: SavedQuery = {
  id: "saved-1",
  profile_id: "profile-pg",
  database: "app",
  name: "Big orders",
  query: "SELECT * FROM orders WHERE total > 100",
  created_at: 1,
  updated_at: 1,
};
let storage: Map<string, string>;
beforeEach(() => {
  storage = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
  for (const fn of Object.values(api)) fn.mockReset();
  api.execute.mockResolvedValue({
    columns: ["id"],
    rows: [[1], [2]],
    affected_rows: 0,
    execution_ms: 3,
    truncated: false,
  });
  api.sessionInTransaction.mockResolvedValue(false);
  api.closeSession.mockResolvedValue(undefined);
  api.listProfiles.mockResolvedValue([]);
  api.listHistory.mockResolvedValue([]);
  api.appendHistory.mockResolvedValue(undefined);
  api.listLibrary.mockResolvedValue([]);
  api.saveLibraryItems.mockResolvedValue(undefined);
  api.deleteLibraryItems.mockResolvedValue(undefined);
  api.clearHistory.mockResolvedValue(undefined);
  api.onLibraryChange.mockResolvedValue(() => undefined);
  api.schema.mockResolvedValue({ database: "app", tables: [] });
  useWorkspace.setState({
    singleTab: false,
    sessions: [
      {
        id: "pg",
        config,
        databases: ["app"],
        trees: { app: { database: "app", tables: [] } },
      },
    ],
    tabs: [
      {
        id: "tab-1",
        name: "Query 1",
        connectionId: "pg",
        database: "app",
        query: "SELECT id FROM orders",
        running: false,
      },
    ],
    activeTab: "tab-1",
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
const tab = (id = "tab-1") =>
  useWorkspace.getState().tabs.find((item) => item.id === id);

it("records SQL run from the editor, but not while history is off", async () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
  await waitFor(() => expect(api.appendHistory).toHaveBeenCalledTimes(1));
  expect(api.appendHistory.mock.calls[0][0]).toMatchObject({
    profile_id: "profile-pg",
    connection_name: "Postgres",
    database: "app",
    sql: "SELECT id FROM orders",
    status: "success",
    rows: 2,
    duration_ms: 3,
  });
  api.execute.mockRejectedValueOnce(new Error("relation missing"));
  await waitFor(() => expect(tab()?.running).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
  await waitFor(() => expect(api.appendHistory).toHaveBeenCalledTimes(2));
  expect(api.appendHistory.mock.calls[1][0]).toMatchObject({
    status: "error",
    error: "relation missing",
  });
  fireEvent.keyDown(window, { key: "H", ctrlKey: true, shiftKey: true });
  const panel = screen.getByRole("dialog", { name: "Query history" });
  expect(within(panel).getAllByRole("listitem")).toHaveLength(2);
  fireEvent.click(
    within(panel).getByRole("checkbox", { name: "Record query history" }),
  );
  expect(storage.get("dbde.history-enabled")).toBe("false");
  fireEvent.keyDown(panel, { key: "Escape" });
  await waitFor(() => expect(tab()?.running).toBe(false));
  fireEvent.click(screen.getByRole("button", { name: /Run query/ }));
  await waitFor(() => expect(api.execute).toHaveBeenCalledTimes(3));
  await waitFor(() => expect(tab()?.running).toBe(false));
  expect(api.appendHistory).toHaveBeenCalledTimes(2);
});

it("opens, inserts, deletes and clears history entries", async () => {
  api.listHistory.mockResolvedValue([
    {
      id: "h1",
      at: 1000,
      profile_id: "profile-pg",
      connection_name: "Postgres",
      database: "app",
      sql: "SELECT 42",
      truncated: false,
      duration_ms: 1,
      status: "success",
      rows: 1,
    },
  ]);
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Query history" }));
  let panel = screen.getByRole("dialog", { name: "Query history" });
  await within(panel).findByText("SELECT 42");
  fireEvent.click(
    within(panel).getByRole("button", { name: /Open in new query tab/ }),
  );
  await waitFor(() => expect(useWorkspace.getState().tabs).toHaveLength(2));
  const opened = useWorkspace.getState().tabs[1];
  expect(opened).toMatchObject({
    connectionId: "pg",
    database: "app",
    query: "SELECT 42",
  });
  expect(screen.queryByRole("dialog", { name: "Query history" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Query history" }));
  panel = screen.getByRole("dialog", { name: "Query history" });
  fireEvent.click(within(panel).getByRole("button", { name: /Insert/ }));
  expect(tab(opened.id)?.query).toBe("SELECT 42\n\nSELECT 42");
  fireEvent.click(screen.getByRole("button", { name: "Query history" }));
  panel = screen.getByRole("dialog", { name: "Query history" });
  fireEvent.click(within(panel).getByRole("button", { name: /Clear history/ }));
  fireEvent.click(await screen.findByRole("button", { name: "Clear history" }));
  await waitFor(() => expect(api.clearHistory).toHaveBeenCalled());
  expect(
    within(screen.getByRole("dialog", { name: "Query history" })).getByText(
      /No queries yet/,
    ),
  ).toBeTruthy();
});

it("saves a query tab, marks unsaved edits and asks before closing", async () => {
  render(<App />);
  fireEvent.click(screen.getByRole("button", { name: "Editor Ctrl+S" }));
  const dialog = screen.getByRole("dialog", { name: "Save query" });
  fireEvent.change(
    within(dialog).getByRole("textbox", { name: "Query name" }),
    {
      target: { value: "Orders report" },
    },
  );
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.saveLibraryItems).toHaveBeenCalledTimes(1));
  const [kind, [item]] = api.saveLibraryItems.mock.calls[0];
  expect(kind).toBe("saved_queries");
  expect(item).toMatchObject({
    profile_id: "profile-pg",
    database: "app",
    name: "Orders report",
    query: "SELECT id FROM orders",
  });
  expect(tab()).toMatchObject({ name: "Orders report", savedQueryId: item.id });
  expect(screen.queryByLabelText("Unsaved query changes")).toBeNull();
  // The explorer lists it under the database's Queries group.
  fireEvent.click(screen.getByRole("button", { name: "Queries in app" }));
  expect(
    within(screen.getByRole("complementary")).getByRole("button", {
      name: "Orders report",
    }),
  ).toBeTruthy();

  useWorkspace.getState().updateTab("tab-1", { query: "SELECT 2" });
  expect(await screen.findByLabelText("Unsaved query changes")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Close Orders report" }));
  let prompt = await screen.findByRole("alertdialog", {
    name: "Save changes to “Orders report”?",
  });
  fireEvent.click(within(prompt).getByRole("button", { name: "Cancel" }));
  await waitFor(() => expect(screen.queryByRole("alertdialog")).toBeNull());
  expect(tab()).toBeTruthy();

  // Ctrl/Cmd+S on a saved tab saves in place without a dialog.
  fireEvent.click(screen.getByRole("button", { name: "Editor Ctrl+S" }));
  await waitFor(() => expect(api.saveLibraryItems).toHaveBeenCalledTimes(2));
  expect(api.saveLibraryItems.mock.calls[1][1][0]).toMatchObject({
    id: item.id,
    query: "SELECT 2",
  });
  await waitFor(() =>
    expect(screen.queryByLabelText("Unsaved query changes")).toBeNull(),
  );

  useWorkspace.getState().updateTab("tab-1", { query: "SELECT 3" });
  fireEvent.click(screen.getByRole("button", { name: "Close Orders report" }));
  prompt = await screen.findByRole("alertdialog");
  fireEvent.click(within(prompt).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(useWorkspace.getState().tabs).toHaveLength(0));
  expect(api.saveLibraryItems.mock.calls[2][1][0]).toMatchObject({
    id: item.id,
    query: "SELECT 3",
  });
});

it("saves as a new query and opens saved queries from the panel", async () => {
  api.listLibrary.mockImplementation(async (kind: string) =>
    kind === "saved_queries" ? [saved] : [],
  );
  render(<App />);
  fireEvent.keyDown(window, { key: "O", ctrlKey: true, shiftKey: true });
  const panel = screen.getByRole("dialog", { name: "Saved queries" });
  fireEvent.click(
    await within(panel).findByRole("button", { name: "Open Big orders" }),
  );
  await waitFor(() => expect(useWorkspace.getState().tabs).toHaveLength(2));
  const opened = useWorkspace.getState().tabs[1];
  expect(opened).toMatchObject({
    name: "Big orders",
    query: saved.query,
    savedQueryId: "saved-1",
    database: "app",
  });
  // Opening it again focuses the same tab.
  w().setActive("tab-1");
  fireEvent.click(screen.getByRole("button", { name: "Saved queries" }));
  fireEvent.click(
    within(screen.getByRole("dialog", { name: "Saved queries" })).getByRole(
      "button",
      { name: "Open Big orders" },
    ),
  );
  expect(useWorkspace.getState().tabs).toHaveLength(2);
  expect(useWorkspace.getState().activeTab).toBe(opened.id);

  fireEvent.click(screen.getByRole("button", { name: "Editor Ctrl+Shift+S" }));
  const dialog = screen.getByRole("dialog", { name: "Save query as" });
  expect(
    (
      within(dialog).getByRole("textbox", {
        name: "Query name",
      }) as HTMLInputElement
    ).value,
  ).toBe("Big orders copy");
  fireEvent.click(within(dialog).getByRole("button", { name: "Save" }));
  await waitFor(() => expect(api.saveLibraryItems).toHaveBeenCalled());
  const copy = api.saveLibraryItems.mock.calls[0][1][0];
  expect(copy.id).not.toBe("saved-1");
  expect(tab(opened.id)).toMatchObject({
    name: "Big orders copy",
    savedQueryId: copy.id,
  });

  fireEvent.click(screen.getByRole("button", { name: "Saved queries" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete Big orders" }));
  fireEvent.click(await screen.findByRole("button", { name: "Delete query" }));
  await waitFor(() =>
    expect(api.deleteLibraryItems).toHaveBeenCalledWith("saved_queries", [
      "saved-1",
    ]),
  );
});

it("inserts snippets and offers them to the editor completion", async () => {
  api.listLibrary.mockImplementation(async (kind: string) =>
    kind === "snippets"
      ? [
          {
            id: "s1",
            name: "Mine",
            prefix: "mine",
            body: "SELECT ${1:col} FROM t;",
          },
        ]
      : [],
  );
  render(<App />);
  await waitFor(() =>
    expect(screen.getByTestId("snippet-prefixes").textContent).toMatch(
      /^mine,/,
    ),
  );
  expect(screen.getByTestId("snippet-prefixes").textContent).toContain("exa");
  fireEvent.click(screen.getByRole("button", { name: "Code snippets" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Insert snippet Mine (mine)" }),
  );
  expect(tab()?.query).toBe("SELECT id FROM orders\n\nSELECT col FROM t;");
  expect(screen.queryByRole("dialog", { name: "Code snippets" })).toBeNull();
});

it("migrates query favorites into saved queries once", async () => {
  storage.set(
    "dbde.tab-favorites",
    JSON.stringify([
      {
        id: "fav-1",
        profile_id: "profile-pg",
        database: "app",
        name: "Pinned",
        kind: "query",
        query: "SELECT 9",
      },
    ]),
  );
  render(<App />);
  await waitFor(() => expect(api.saveLibraryItems).toHaveBeenCalledTimes(1));
  expect(api.saveLibraryItems.mock.calls[0][1]).toEqual([
    expect.objectContaining({ id: "fav-1", name: "Pinned", query: "SELECT 9" }),
  ]);
  await waitFor(() =>
    expect(storage.get("dbde.query-favorites-migrated")).toBe("1"),
  );
  cleanup();
  render(<App />);
  await waitFor(() => expect(api.listLibrary).toHaveBeenCalledTimes(4));
  expect(api.saveLibraryItems).toHaveBeenCalledTimes(1);
});
const w = () => useWorkspace.getState();

it("applies history and saved-query changes made in other windows", async () => {
  render(<App />);
  await waitFor(() => expect(api.onLibraryChange).toHaveBeenCalled());
  const listener = api.onLibraryChange.mock.calls[0][0];
  const entry = {
    id: "remote",
    at: 5,
    profile_id: "profile-pg",
    connection_name: "Postgres",
    database: "app",
    sql: "SELECT 'from detached window'",
    truncated: false,
    duration_ms: 2,
    status: "success",
  };
  act(() => {
    listener({ kind: "history", op: "append", entry });
    listener({ kind: "history", op: "append", entry });
  });
  api.listLibrary.mockResolvedValue([saved]);
  act(() => listener({ kind: "saved_queries", op: "reload" }));
  fireEvent.keyDown(window, { key: "h", ctrlKey: true, shiftKey: true });
  const panel = screen.getByRole("dialog", { name: "Query history" });
  expect(within(panel).getAllByRole("listitem")).toHaveLength(1);
  expect(within(panel).getByText("SELECT 'from detached window'")).toBeTruthy();
  fireEvent.keyDown(panel, { key: "Escape" });
  await waitFor(() =>
    expect(screen.getByRole("button", { name: "Queries in app" })).toBeTruthy(),
  );
});
