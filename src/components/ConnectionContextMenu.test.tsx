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
import ConnectionContextMenu from "./ConnectionContextMenu";
import type { ConnectionConfig } from "../types";
const config: ConnectionConfig = {
  id: "local",
  name: "Local",
  driver: "mysql",
  host: "localhost",
  port: 3306,
  username: "root",
  database: "app",
  file_path: "",
  ssl_mode: "disable",
};
afterEach(cleanup);
function menu(driver: ConnectionConfig["driver"] = "mysql") {
  const onAction = vi.fn(),
    onClose = vi.fn();
  render(
    <ConnectionContextMenu
      target={{
        config: { ...config, driver },
        sessionId: "active",
        x: 10,
        y: 10,
        trigger: document.body,
      }}
      profiles={[config, { ...config, id: "other", name: "Production" }]}
      appearance={{ starred: true }}
      groups={["Local servers"]}
      onAction={onAction}
      onClose={onClose}
    />,
  );
  return { onAction, onClose };
}
it("matches the reference menu order and shortcut groups", () => {
  menu();
  const root = screen.getByRole("menu", { name: "Local connection actions" });
  expect(
    within(root)
      .getAllByRole("menuitem")
      .filter((item) => !item.hasAttribute("data-color"))
      .map(
        (item) => item.querySelector("span")?.textContent ?? item.textContent,
      ),
  ).toEqual([
    "Close Connection",
    "Switch Connection Profile",
    "Edit Connection…",
    "New Connection",
    "Delete Connection",
    "Duplicate Connection…",
    "New Database…",
    "New Query",
    "Execute SQL File…",
    "Flush",
    "Remove Star",
    "Manage Group",
    "Share…",
    "Refresh",
  ]);
  expect(within(root).getAllByRole("separator")).toHaveLength(6);
});
it("navigates into a profile submenu with arrows and restores focus with Escape", async () => {
  const { onClose } = menu();
  const close = screen.getByRole("menuitem", { name: /^Close Connection/ });
  expect(document.activeElement).toBe(close);
  fireEvent.keyDown(close, { key: "ArrowDown" });
  const profiles = screen.getByRole("menuitem", {
    name: "Switch Connection Profile",
  });
  expect(document.activeElement).toBe(profiles);
  fireEvent.keyDown(profiles, { key: "ArrowRight" });
  const submenu = screen.getByRole("menu", { name: "Connection profiles" });
  await waitFor(() =>
    expect(document.activeElement).toBe(
      within(submenu).getByRole("menuitemradio", { name: "Local" }),
    ),
  );
  fireEvent.keyDown(document.activeElement!, { key: "Escape" });
  expect(
    screen.queryByRole("menu", { name: "Connection profiles" }),
  ).toBeNull();
  expect(document.activeElement).toBe(profiles);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.keyDown(profiles, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});
it("dispatches colors and groups, and does not dismiss on internal scroll", () => {
  const { onAction, onClose } = menu();
  const root = screen.getByRole("menu", { name: "Local connection actions" });
  fireEvent.scroll(root);
  expect(onClose).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Color green" }));
  expect(onAction).toHaveBeenCalledWith("color", "#76d5a4");
  fireEvent.click(screen.getByRole("menuitem", { name: "Manage Group" }));
  fireEvent.click(screen.getByRole("menuitemradio", { name: "Local servers" }));
  expect(onAction).toHaveBeenCalledWith("group", "Local servers");
});
it("disables MySQL-only Flush for PostgreSQL and file administration for SQLite", () => {
  const { unmount } = render(
    <ConnectionContextMenu
      target={{
        config: { ...config, driver: "postgres" },
        sessionId: "active",
        x: 0,
        y: 0,
        trigger: document.body,
      }}
      profiles={[]}
      groups={[]}
      appearance={{}}
      onAction={vi.fn()}
      onClose={vi.fn()}
    />,
  );
  expect(
    screen.getByRole("menuitem", { name: "Flush" }).hasAttribute("disabled"),
  ).toBe(true);
  unmount();
  menu("sqlite");
  expect(
    screen
      .getByRole("menuitem", { name: "New Database…" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
