// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import App from "./App";
import { useWorkspace } from "./store";
import type { ConnectionConfig, QueryResult } from "./types";
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
vi.mock("./components/QueryEditor", () => ({
  default: ({ value }: { value: string }) => (
    <textarea aria-label="SQL text" defaultValue={value} />
  ),
}));
vi.mock("./lib/api", () => ({
  desktop: true,
  columns: async () => [],
  listProfiles: vi.fn().mockResolvedValue([]),
  connect: vi.fn(),
  viewTable: vi.fn(),
  deleteRows: vi.fn(),
  applyChanges: vi.fn(),
  schema: async () => ({ database: "workspace", tables: [] }),
  listHistory: async () => [],
  appendHistory: async () => undefined,
  listLibrary: async () => [],
  saveLibraryItems: async () => undefined,
  deleteLibraryItems: async () => undefined,
  onLibraryChange: async () => () => undefined,
}));
const config: ConnectionConfig = {
  id: "profile-1",
  name: "Local SQLite",
  driver: "sqlite",
  host: "",
  port: 0,
  username: "",
  database: "workspace",
  file_path: ":memory:",
  ssl_mode: "disable",
};
const table = { name: "customers", schema: "", kind: "table" };
const result: QueryResult = {
  columns: ["id", "name", "note"],
  rows: [[1, "Ada", "x"]],
  affected_rows: 0,
  execution_ms: 1,
  truncated: false,
  source: { database: "workspace", table, primary_keys: ["id"] },
};
let saved: Map<string, string>;
function open(sessionId: string) {
  useWorkspace.setState({
    sessions: [
      {
        id: sessionId,
        config,
        databases: ["workspace"],
        trees: { workspace: { database: "workspace", tables: [table] } },
      },
    ],
    tabs: [
      {
        id: "table-tab",
        name: "customers",
        connectionId: sessionId,
        database: "workspace",
        query: "SELECT * FROM customers;",
        result,
        running: false,
      },
    ],
    activeTab: "table-tab",
  });
  return render(<App />);
}
const headers = () =>
  screen
    .getAllByRole("columnheader")
    .map((header) => header.getAttribute("aria-label"));
beforeEach(() => {
  saved = new Map();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => saved.get(name) ?? null,
    setItem: (name: string, value: string) => saved.set(name, value),
    removeItem: (name: string) => saved.delete(name),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
it("remembers hidden and frozen columns per connection profile across sessions", () => {
  const first = open("session-1");
  const menu = (column: string, item: string) => {
    fireEvent.contextMenu(screen.getByRole("columnheader", { name: column }), {
      clientX: 10,
      clientY: 10,
    });
    fireEvent.click(screen.getByRole("menuitem", { name: item }));
  };
  menu("name", "Hide Column");
  menu("note", "Freeze Column");
  expect(headers()).toEqual(["note", "id"]);
  expect(
    JSON.parse(
      saved.get('dbde.grid-layout:["profile-1","workspace","","customers"]')!,
    ),
  ).toEqual({
    columns: ["id", "name", "note"],
    hidden: ["name"],
    frozen: ["note"],
  });
  first.unmount();
  // Reconnecting creates a new session id for the same profile.
  open("session-2");
  expect(headers()).toEqual(["note", "id"]);
});
