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
import TableDesigner from "./TableDesigner";
import type { Driver, Session } from "../types";
const { createTable } = vi.hoisted(() => ({ createTable: vi.fn() }));
vi.mock("../lib/api", () => ({ createTable }));
const session: Session = {
  id: "mysql",
  config: {
    id: "profile",
    name: "Local DB",
    driver: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    database: "app",
    ssl_mode: "disable",
    file_path: "",
  },
};
beforeEach(() => {
  createTable.mockReset();
  createTable.mockResolvedValue({
    name: "customers",
    schema: "app",
    kind: "table",
  });
});
afterEach(cleanup);
function designer(driver: Driver = "mysql") {
  const onClose = vi.fn(),
    onCreated = vi.fn();
  const request = {
    session: { ...session, config: { ...session.config, driver } },
    database: "app",
  };
  return {
    onClose,
    onCreated,
    ...render(
      <TableDesigner
        request={request}
        onClose={onClose}
        onCreated={onCreated}
      />,
    ),
  };
}
const change = (name: string, value: string) =>
  fireEvent.change(screen.getByRole("textbox", { name }), {
    target: { value },
  });
describe("Navicat-style table designer", () => {
  it("offers a field grid and selected-field properties, reorders and previews the exact design", async () => {
    designer();
    change("Table name", "customers");
    fireEvent.click(screen.getByRole("button", { name: "Add Field" }));
    await waitFor(() =>
      expect(document.activeElement).toBe(
        screen.getByRole("textbox", { name: "Field 2 name" }),
      ),
    );
    change("Field 2 name", "name");
    fireEvent.change(screen.getByRole("combobox", { name: "Field 2 type" }), {
      target: { value: "varchar" },
    });
    expect(
      (
        screen.getByRole("textbox", {
          name: "Field 2 length",
        }) as HTMLInputElement
      ).value,
    ).toBe("255");
    fireEvent.click(screen.getByRole("button", { name: "Move Up" }));
    expect(
      (
        screen.getByRole("textbox", {
          name: "Field 1 name",
        }) as HTMLInputElement
      ).value,
    ).toBe("name");
    fireEvent.click(screen.getByRole("button", { name: "Move Down" }));
    fireEvent.change(screen.getByRole("combobox", { name: "Default mode" }), {
      target: { value: "value" },
    });
    change("Default value", "Guest");
    fireEvent.click(screen.getByRole("tab", { name: "SQL Preview" }));
    expect(screen.getByLabelText("Create table SQL").textContent).toContain(
      "`name` varchar(255) DEFAULT 'Guest'",
    );
    expect(createTable).not.toHaveBeenCalled();
  });
  it("supports indexes and saves through the structured API without losing field settings", async () => {
    const { onCreated } = designer();
    change("Table name", "customers");
    fireEvent.click(screen.getByRole("tab", { name: "Indexes" }));
    fireEvent.click(screen.getByRole("button", { name: "Add Index" }));
    change("Index 1 name", "id_unique");
    fireEvent.click(screen.getByRole("checkbox", { name: "Unique" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "id" }));
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await waitFor(() =>
      expect(onCreated).toHaveBeenCalledWith({
        name: "customers",
        schema: "app",
        kind: "table",
      }),
    );
    expect(createTable).toHaveBeenCalledWith(
      "mysql",
      "app",
      expect.objectContaining({
        name: "customers",
        indexes: [expect.objectContaining({ name: "id_unique", unique: true })],
      }),
    );
  });
  it("keeps the design after server failure and requires explicit discard on close", async () => {
    createTable.mockRejectedValue(new Error("Table already exists"));
    const { onClose, onCreated } = designer();
    change("Table name", "customers");
    fireEvent.click(screen.getByRole("button", { name: /Save/ }));
    await screen.findByRole("alert");
    expect(screen.getByRole("alert").textContent).toContain(
      "Table already exists",
    );
    expect(
      (screen.getByRole("textbox", { name: "Table name" }) as HTMLInputElement)
        .value,
    ).toBe("customers");
    expect(onCreated).not.toHaveBeenCalled();
    fireEvent.click(
      screen.getByRole("button", { name: "Close table designer" }),
    );
    expect(onClose).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "Keep editing" }));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    fireEvent.click(screen.getByRole("button", { name: "Discard design" }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
  it("blocks invalid designs, supports keyboard field insertion, and moves tabs with arrows", async () => {
    designer();
    change("Table name", "customers");
    const dialog = screen.getByRole("dialog");
    fireEvent.keyDown(dialog, { key: "+", metaKey: true });
    await waitFor(() =>
      expect(
        screen.getByRole("textbox", { name: "Field 2 name" }),
      ).toBeTruthy(),
    );
    expect(screen.getByRole("alert").textContent).toContain("Field");
    fireEvent.keyDown(dialog, { key: "s", metaKey: true });
    expect(createTable).not.toHaveBeenCalled();
    change("Field 2 name", "qty");
    const fields = screen.getByRole("tab", { name: /Fields/ });
    fireEvent.keyDown(fields, { key: "ArrowRight" });
    expect(
      screen
        .getByRole("tab", { name: "Indexes" })
        .getAttribute("aria-selected"),
    ).toBe("true");
    expect(document.activeElement).toBe(
      screen.getByRole("tab", { name: "Indexes" }),
    );
  });
  it("shows only dialect-supported settings", () => {
    designer("sqlite");
    expect(screen.queryByRole("tab", { name: "Options" })).toBeNull();
    expect(screen.queryByRole("tab", { name: "Comment" })).toBeNull();
    expect(screen.queryByRole("textbox", { name: "Table schema" })).toBeNull();
    expect(
      within(screen.getByRole("table")).queryByRole("columnheader", {
        name: "Comment",
      }),
    ).toBeNull();
    expect(
      screen
        .getByRole("checkbox", { name: "Auto increment" })
        .getAttribute("disabled"),
    ).toBeNull();
  });
});
