// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import HistoryPanel, { HISTORY_PAGE } from "./HistoryPanel";
import type { HistoryEntry } from "../lib/query-history";
afterEach(cleanup);

const entry = (patch: Partial<HistoryEntry>): HistoryEntry => ({
  id: crypto.randomUUID(),
  at: Date.now(),
  profile_id: "p1",
  connection_name: "Local",
  database: "app",
  sql: "SELECT 1",
  truncated: false,
  duration_ms: 4,
  status: "success",
  rows: 1,
  ...patch,
});
function setup(entries: HistoryEntry[], patch: Record<string, unknown> = {}) {
  const props = {
    entries,
    enabled: true,
    canInsert: true,
    onToggleEnabled: vi.fn(),
    onOpen: vi.fn(),
    onInsert: vi.fn(),
    onCopy: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn(),
    onClear: vi.fn(),
    onClose: vi.fn(),
    ...patch,
  };
  render(<HistoryPanel {...props} />);
  return props;
}

it("lists newest first with status, duration and summary, and runs entry actions", async () => {
  const older = entry({ id: "old", at: 1_000, sql: "SELECT * FROM orders" });
  const newer = entry({
    id: "new",
    at: 2_000,
    sql: "DELETE FROM orders",
    status: "error",
    error: "permission denied",
    duration_ms: 1500,
  });
  const props = setup([older, newer]);
  expect(document.activeElement).toBe(
    screen.getByRole("textbox", { name: "Search history" }),
  );
  const items = within(
    screen.getByRole("list", { name: "History entries" }),
  ).getAllByRole("listitem");
  expect(items[0].textContent).toContain("DELETE FROM orders");
  expect(items[0].textContent).toContain("Error");
  expect(items[0].textContent).toContain("1.50 s");
  expect(items[0].textContent).toContain("permission denied");
  expect(items[1].textContent).toContain("1 row");
  fireEvent.click(
    within(items[1]).getByRole("button", { name: /Open in new query tab/ }),
  );
  expect(props.onOpen).toHaveBeenCalledWith(older);
  fireEvent.click(within(items[1]).getByRole("button", { name: /Insert/ }));
  expect(props.onInsert).toHaveBeenCalledWith(older);
  fireEvent.click(within(items[1]).getByRole("button", { name: /Copy/ }));
  expect(props.onCopy).toHaveBeenCalledWith(older);
  await waitFor(() =>
    expect(screen.getByRole("status").textContent).toBe("SQL copied."),
  );
  fireEvent.click(
    within(items[0]).getByRole("button", { name: "Delete history entry" }),
  );
  expect(props.onDelete).toHaveBeenCalledWith(newer);
  fireEvent.click(screen.getByRole("button", { name: /Clear history/ }));
  expect(props.onClear).toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Record query history" }),
  );
  expect(props.onToggleEnabled).toHaveBeenCalledWith(false);
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(props.onClose).toHaveBeenCalled();
});

it("searches and filters by connection, database and status", () => {
  setup([
    entry({ id: "a", sql: "SELECT * FROM orders" }),
    entry({
      id: "b",
      sql: "SELECT * FROM users",
      profile_id: "p2",
      connection_name: "Prod",
      database: "shop",
    }),
    entry({ id: "c", sql: "UPDATE users SET a = 1", status: "cancelled" }),
  ]);
  const list = () =>
    within(
      screen.getByRole("list", { name: "History entries" }),
    ).queryAllByRole("listitem");
  fireEvent.change(screen.getByRole("textbox", { name: "Search history" }), {
    target: { value: "users" },
  });
  expect(list()).toHaveLength(2);
  fireEvent.change(
    screen.getByRole("combobox", { name: "Filter by connection" }),
    { target: { value: "p2" } },
  );
  expect(list()).toHaveLength(1);
  expect(
    within(screen.getByRole("combobox", { name: "Filter by database" }))
      .getAllByRole("option")
      .map((o) => o.textContent),
  ).toEqual(["All databases", "shop"]);
  fireEvent.change(
    screen.getByRole("combobox", { name: "Filter by connection" }),
    { target: { value: "" } },
  );
  fireEvent.change(screen.getByRole("combobox", { name: "Filter by status" }), {
    target: { value: "cancelled" },
  });
  expect(list()).toHaveLength(1);
  expect(list()[0].textContent).toContain("Cancelled");
  fireEvent.change(screen.getByRole("textbox", { name: "Search history" }), {
    target: { value: "nothing-matches" },
  });
  expect(screen.getByText("No history matches these filters.")).toBeTruthy();
});

it("pages long histories and disables insert without an editor", () => {
  const many = Array.from({ length: HISTORY_PAGE + 5 }, (_, i) =>
    entry({ id: String(i), at: i }),
  );
  setup(many, { canInsert: false, enabled: false });
  // Role queries over 100+ items are slow in jsdom; the list itself is found by role.
  const list = () =>
    Array.from(
      screen
        .getByRole("list", { name: "History entries" })
        .querySelectorAll<HTMLElement>(":scope > li"),
    );
  expect(list()).toHaveLength(HISTORY_PAGE);
  expect(screen.getByRole("note").textContent).toMatch(/History is off/);
  expect(
    within(list()[0])
      .getByRole("button", { name: /Insert/ })
      .hasAttribute("disabled"),
  ).toBe(true);
  const more = screen.getByText(/Show more \(5 older\)/).closest("button")!;
  fireEvent.click(more);
  expect(list()).toHaveLength(HISTORY_PAGE + 5);
});
