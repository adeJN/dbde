// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import DatabaseTables from "./DatabaseTables";
import type { Session } from "../types";
Object.defineProperty(navigator, "platform", {
  configurable: true,
  value: "MacIntel",
});
afterEach(cleanup);
const tables = ["alpha", "beta", "gamma"].map((name) => ({
  name,
  schema: "shop",
  kind: "table",
}));
const session: Session = {
  id: "local",
  config: {
    id: "profile",
    name: "Local",
    driver: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    database: "shop",
    ssl_mode: "disable",
    file_path: "",
  },
  trees: { shop: { database: "shop", tables } },
};
it("selects with clicks/arrows, copies a range, pastes, and opens with Enter or double-click", async () => {
  const onOpen = vi.fn(),
    onCopy = vi.fn(),
    onPaste = vi.fn(),
    onAction = vi.fn(),
    onQuery = vi.fn(),
    onCreate = vi.fn();
  const loadSchema = vi.fn().mockResolvedValue(session.trees!.shop);
  render(
    <DatabaseTables
      session={session}
      database="shop"
      loadSchema={loadSchema}
      onOpen={onOpen}
      onCopy={onCopy}
      onPaste={onPaste}
      canPaste
      onCreate={onCreate}
      onQuery={onQuery}
      onAction={onAction}
    />,
  );
  const alpha = screen.getByRole("button", { name: "alpha" });
  fireEvent.click(alpha);
  expect(onOpen).not.toHaveBeenCalled();
  fireEvent.keyDown(alpha, { key: "ArrowDown", shiftKey: true });
  const beta = screen.getByRole("button", { name: "beta" });
  expect(document.activeElement).toBe(beta);
  fireEvent.keyDown(beta, { key: "c", metaKey: true });
  expect(onCopy).toHaveBeenLastCalledWith(tables.slice(0, 2));
  fireEvent.keyDown(beta, { key: "a", metaKey: true });
  fireEvent.keyDown(beta, { key: "c", metaKey: true });
  expect(onCopy).toHaveBeenLastCalledWith(tables);
  fireEvent.keyDown(beta, { key: "v", metaKey: true });
  expect(onPaste).toHaveBeenCalled();
  fireEvent.keyDown(beta, { key: "Enter" });
  expect(onOpen).toHaveBeenLastCalledWith(tables[1]);
  fireEvent.doubleClick(alpha);
  expect(onOpen).toHaveBeenLastCalledWith(tables[0]);
  fireEvent.keyDown(alpha, { key: "d", metaKey: true });
  expect(onAction).toHaveBeenLastCalledWith(tables[0], "structure");
  fireEvent.keyDown(alpha, { key: "d", metaKey: true, shiftKey: true });
  expect(onAction).toHaveBeenLastCalledWith(tables[0], "copy");
  fireEvent.keyDown(alpha, { key: "y", metaKey: true });
  expect(onQuery).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(alpha, { key: "y", metaKey: true, shiftKey: true });
  expect(onQuery).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(alpha, { key: "n", metaKey: true });
  expect(onCreate).toHaveBeenCalledTimes(1);
  fireEvent.keyDown(alpha, { key: "t", metaKey: true, shiftKey: true });
  expect(onAction).toHaveBeenLastCalledWith(tables[0], "transfer");
  fireEvent.contextMenu(alpha);
  const contextMenu = screen.getByRole("menu");
  fireEvent.keyDown(contextMenu, { key: "d", metaKey: true, shiftKey: true });
  expect(onAction).toHaveBeenLastCalledWith(tables[0], "copy");
  const search = screen.getByRole("textbox", {
    name: "Search tables in database",
  });
  onCopy.mockClear();
  fireEvent.keyDown(search, { key: "c", metaKey: true });
  expect(onCopy).not.toHaveBeenCalled();
  fireEvent.keyDown(alpha, { key: "f", metaKey: true });
  await waitFor(() => expect(document.activeElement).toBe(search));
  fireEvent.keyDown(search, { key: "r", metaKey: true });
  await waitFor(() => expect(loadSchema).toHaveBeenCalledWith("local", "shop"));
});
it("keeps Enter on the New Table toolbar button available to the button", () => {
  const onOpen = vi.fn();
  render(
    <DatabaseTables
      session={session}
      database="shop"
      loadSchema={vi.fn()}
      onOpen={onOpen}
      onCreate={vi.fn()}
      onAction={vi.fn()}
    />,
  );
  fireEvent.keyDown(screen.getByRole("button", { name: "New Table" }), {
    key: "Enter",
  });
  expect(onOpen).not.toHaveBeenCalled();
});
it("opens database-list actions on empty space without replacing a table's own menu", () => {
  const onCreate = vi.fn();
  render(
    <DatabaseTables
      session={session}
      database="shop"
      loadSchema={vi.fn()}
      onOpen={vi.fn()}
      onCreate={onCreate}
      onAction={vi.fn()}
    />,
  );
  const section = screen.getByRole("region", { name: "Tables in shop" });
  expect(fireEvent.contextMenu(section, { clientX: 40, clientY: 40 })).toBe(
    false,
  );
  expect(screen.getByRole("menu", { name: "Table list actions" })).toBeTruthy();
  fireEvent.click(screen.getByRole("menuitem", { name: "New Table…" }));
  expect(onCreate).toHaveBeenCalledOnce();
  fireEvent.contextMenu(screen.getByRole("button", { name: "alpha" }));
  expect(screen.getByRole("menu", { name: "alpha actions" })).toBeTruthy();
  expect(screen.queryByRole("menu", { name: "Table list actions" })).toBeNull();
});

it("opens each database tool directly from the table list toolbar", () => {
  const onTool = vi.fn();
  render(
    <DatabaseTables
      session={session}
      database="shop"
      loadSchema={vi.fn()}
      onOpen={vi.fn()}
      onCreate={vi.fn()}
      onAction={vi.fn()}
      onTool={onTool}
    />,
  );
  for (const pane of [
    "Data Transfer",
    "Object Information",
    "Query Builder",
    "ER Model",
    "Server Monitor",
  ]) {
    fireEvent.click(screen.getByRole("button", { name: pane }));
    expect(onTool).toHaveBeenLastCalledWith(pane);
  }
});
