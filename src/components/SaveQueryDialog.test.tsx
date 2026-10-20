// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import SaveQueryDialog from "./SaveQueryDialog";
import UnsavedQueryDialog from "./UnsavedQueryDialog";
import SavedQueriesPanel from "./SavedQueriesPanel";
import ExplorerQueries from "./ExplorerQueries";
import type { SavedQuery } from "../lib/saved-queries";
afterEach(cleanup);

it("validates the name and reports save failures", async () => {
  const onSubmit = vi
    .fn()
    .mockRejectedValueOnce(new Error("disk full"))
    .mockResolvedValue(undefined);
  render(
    <SaveQueryDialog
      title="Save query"
      submitLabel="Save"
      location="Local / app"
      initialName="Query 1"
      nameError={(name) =>
        name === "Taken"
          ? "A saved query with this name already exists."
          : name.trim()
            ? ""
            : "Enter a name."
      }
      onSubmit={onSubmit}
      onClose={vi.fn()}
    />,
  );
  const name = screen.getByRole("textbox", { name: "Query name" });
  expect(document.activeElement).toBe(name);
  fireEvent.change(name, { target: { value: "Taken" } });
  expect(
    screen.getByRole("button", { name: "Save" }).hasAttribute("disabled"),
  ).toBe(true);
  fireEvent.change(name, { target: { value: " Orders " } });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Description (optional)" }),
    { target: { value: "Daily" } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(await screen.findByRole("alert")).toBeTruthy();
  expect(screen.getByRole("alert").textContent).toContain("disk full");
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  await waitFor(() => expect(onSubmit).toHaveBeenCalledTimes(2));
  expect(onSubmit).toHaveBeenLastCalledWith({
    name: "Orders",
    description: "Daily",
  });
});

it("offers save, discard and cancel for unsaved query edits", () => {
  const onResolve = vi.fn();
  render(
    <UnsavedQueryDialog
      name="Orders"
      action="Closing the tab"
      onResolve={onResolve}
    />,
  );
  expect(
    screen.getByRole("alertdialog", { name: "Save changes to “Orders”?" }),
  ).toBeTruthy();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "Save" }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Don’t save" }));
  fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
  fireEvent.click(screen.getByRole("button", { name: "Save" }));
  expect(onResolve.mock.calls.map((call) => call[0])).toEqual([
    "discard",
    "cancel",
    "save",
  ]);
});

const queries: SavedQuery[] = [
  {
    id: "a",
    profile_id: "p1",
    database: "app",
    name: "Orders",
    description: "Daily",
    query: "SELECT 1",
    created_at: 1,
    updated_at: 1,
  },
  {
    id: "b",
    profile_id: "p2",
    database: "shop",
    name: "Users",
    query: "SELECT * FROM users",
    created_at: 1,
    updated_at: 1,
  },
];
it("lists saved queries by connection with open, rename, duplicate and delete", () => {
  const actions = {
    onOpen: vi.fn(),
    onRename: vi.fn(),
    onDuplicate: vi.fn(),
    onDelete: vi.fn(),
  };
  render(
    <SavedQueriesPanel
      queries={queries}
      connectionName={(id) => (id === "p1" ? "Local" : "Prod")}
      onClose={vi.fn()}
      {...actions}
    />,
  );
  expect(screen.getByRole("region", { name: "Local / app" })).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "Open Orders" }));
  fireEvent.click(screen.getByRole("button", { name: "Rename Orders" }));
  fireEvent.click(screen.getByRole("button", { name: "Duplicate Users" }));
  fireEvent.click(screen.getByRole("button", { name: "Delete Users" }));
  expect(actions.onOpen).toHaveBeenCalledWith(queries[0]);
  expect(actions.onRename).toHaveBeenCalledWith(queries[0]);
  expect(actions.onDuplicate).toHaveBeenCalledWith(queries[1]);
  expect(actions.onDelete).toHaveBeenCalledWith(queries[1]);
  fireEvent.change(
    screen.getByRole("textbox", { name: "Search saved queries" }),
    { target: { value: "users" } },
  );
  expect(screen.queryByRole("region", { name: "Local / app" })).toBeNull();
});

it("shows a collapsed Queries group in the explorer that expands on search", () => {
  const onOpen = vi.fn();
  const { rerender } = render(
    <ExplorerQueries
      database="app"
      queries={[queries[0]]}
      search=""
      onOpen={onOpen}
      onManage={vi.fn()}
    />,
  );
  const toggle = screen.getByRole("button", { name: "Queries in app" });
  expect(toggle.getAttribute("aria-expanded")).toBe("false");
  expect(screen.queryByRole("button", { name: "Orders" })).toBeNull();
  fireEvent.click(toggle);
  fireEvent.click(screen.getByRole("button", { name: "Orders" }));
  expect(onOpen).toHaveBeenCalledWith(queries[0]);
  rerender(
    <ExplorerQueries
      database="app"
      queries={[queries[0]]}
      search="zzz"
      onOpen={onOpen}
      onManage={vi.fn()}
    />,
  );
  expect(screen.queryByRole("button", { name: "Queries in app" })).toBeNull();
});
