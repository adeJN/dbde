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
import SnippetsPanel from "./SnippetsPanel";
import type { Snippet } from "../lib/snippets";
afterEach(cleanup);

const mine: Snippet = {
  id: "u1",
  name: "Recent orders",
  prefix: "ro",
  body: "SELECT * FROM orders LIMIT ${1:10};",
};
function setup(patch: Record<string, unknown> = {}) {
  const props = {
    driver: "postgres" as const,
    snippets: [mine],
    canInsert: true,
    onInsert: vi.fn(),
    onSave: vi.fn().mockResolvedValue(undefined),
    onDelete: vi.fn(),
    onClose: vi.fn(),
    ...patch,
  };
  render(<SnippetsPanel {...props} />);
  return props;
}

it("inserts built-in and user snippets with a placeholder preview", () => {
  const props = setup();
  const list = screen.getByRole("list", { name: "Snippets" });
  expect(
    within(list).getByRole("button", { name: /EXPLAIN ANALYZE/ }),
  ).toBeTruthy();
  expect(
    within(list).queryByRole("button", { name: /SHOW PROCESSLIST/ }),
  ).toBeNull();
  const user = within(list).getByRole("button", {
    name: "Insert snippet Recent orders (ro)",
  });
  expect(user.textContent).toContain("SELECT * FROM orders LIMIT 10;");
  fireEvent.click(user);
  expect(props.onInsert).toHaveBeenCalledWith(mine);
  fireEvent.change(screen.getByRole("textbox", { name: "Search snippets" }), {
    target: { value: "upsert" },
  });
  fireEvent.click(within(list).getByRole("button", { name: /Upsert/ }));
  expect(props.onInsert.mock.calls[1][0].body).toContain("ON CONFLICT");
});

it("creates, edits and deletes user snippets", async () => {
  const props = setup();
  fireEvent.click(screen.getByRole("button", { name: /New snippet/ }));
  const form = screen.getByRole("form", { name: "New snippet" });
  const save = within(form).getByRole("button", { name: "Save snippet" });
  expect(save.hasAttribute("disabled")).toBe(true);
  fireEvent.change(within(form).getByRole("textbox", { name: "Name" }), {
    target: { value: "Count" },
  });
  fireEvent.change(within(form).getByRole("textbox", { name: "Prefix" }), {
    target: { value: "cnt" },
  });
  fireEvent.change(within(form).getByRole("textbox", { name: /Body/ }), {
    target: { value: "SELECT COUNT(*) FROM ${1:t};" },
  });
  fireEvent.click(within(form).getByRole("checkbox", { name: /Only for/ }));
  fireEvent.click(save);
  await waitFor(() => expect(props.onSave).toHaveBeenCalled());
  expect(props.onSave.mock.calls[0][0]).toMatchObject({
    name: "Count",
    prefix: "cnt",
    body: "SELECT COUNT(*) FROM ${1:t};",
    drivers: ["postgres"],
  });
  expect(props.onSave.mock.calls[0][0].id).toBeTruthy();
  await waitFor(() => expect(screen.queryByRole("form")).toBeNull());
  fireEvent.click(
    screen.getByRole("button", { name: "Edit snippet Recent orders" }),
  );
  expect(
    (screen.getByRole("textbox", { name: "Prefix" }) as HTMLInputElement).value,
  ).toBe("ro");
  fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
  expect(props.onClose).not.toHaveBeenCalled();
  fireEvent.click(
    screen.getByRole("button", { name: "Delete snippet Recent orders" }),
  );
  expect(props.onDelete).toHaveBeenCalledWith(mine);
});

it("disables insertion without a query tab", () => {
  setup({ canInsert: false });
  expect(screen.getByRole("note").textContent).toMatch(/Open a query tab/);
  expect(
    screen
      .getByRole("button", { name: "Insert snippet Recent orders (ro)" })
      .hasAttribute("disabled"),
  ).toBe(true);
});
