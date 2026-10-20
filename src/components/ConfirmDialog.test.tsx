// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ConfirmDialog from "./ConfirmDialog";
afterEach(cleanup);
it("requires acknowledgement, passes the selected FK mode, and resets for another deletion", () => {
  const onResolve = vi.fn();
  const onForeignKeyChecks = vi.fn();
  const request = {
    title: 'Are you sure you want to delete "tamu_copy1"?',
    body: "",
    confirmLabel: "Delete",
    tableDeletion: { allowForeignKeyChecks: true, onForeignKeyChecks },
  };
  const { rerender } = render(
    <ConfirmDialog request={request} onResolve={onResolve} />,
  );
  const button = screen.getByRole("button", {
    name: "Delete",
  }) as HTMLButtonElement;
  expect(button.disabled).toBe(true);
  fireEvent.click(button);
  expect(onResolve).not.toHaveBeenCalled();
  fireEvent.change(
    screen.getByRole("combobox", { name: "Foreign Key Checks" }),
    { target: { value: "disable" } },
  );
  fireEvent.click(screen.getByRole("checkbox", { name: /I understand/ }));
  fireEvent.click(button);
  expect(onForeignKeyChecks).toHaveBeenCalledWith("disable");
  expect(onResolve).toHaveBeenCalledWith(true);
  rerender(
    <ConfirmDialog
      request={{ ...request, title: "Delete another table?" }}
      onResolve={onResolve}
    />,
  );
  expect(
    (screen.getByRole("button", { name: "Delete" }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  expect(
    (
      screen.getByRole("combobox", {
        name: "Foreign Key Checks",
      }) as HTMLSelectElement
    ).value,
  ).toBe("default");
});
it("keeps PostgreSQL/SQLite FK settings at Default and cancels with Escape", () => {
  const onResolve = vi.fn();
  render(
    <ConfirmDialog
      request={{
        title: "Delete table?",
        body: "",
        confirmLabel: "Delete",
        tableDeletion: {
          allowForeignKeyChecks: false,
          onForeignKeyChecks: vi.fn(),
        },
      }}
      onResolve={onResolve}
    />,
  );
  expect(
    (
      screen.getByRole("combobox", {
        name: "Foreign Key Checks",
      }) as HTMLSelectElement
    ).disabled,
  ).toBe(true);
  fireEvent.keyDown(screen.getByRole("alertdialog"), { key: "Escape" });
  expect(onResolve).toHaveBeenCalledWith(false);
});
