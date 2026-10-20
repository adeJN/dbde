// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import RenameTableDialog from "./RenameTableDialog";
afterEach(cleanup);
const base = {
  table: { name: "admin", schema: "", kind: "table" },
  database: "test buat",
  driver: "mysql" as const,
  existing: [
    { name: "admin", schema: "", kind: "table" },
    { name: "users", schema: "", kind: "table" },
  ],
  onClose: vi.fn(),
};
const field = () =>
  screen.getByRole("textbox", { name: "New name" }) as HTMLInputElement;
describe("rename table dialog", () => {
  it("starts with the current name selected and blocks invalid names", () => {
    render(<RenameTableDialog {...base} onRename={vi.fn()} />);
    expect(document.activeElement).toBe(field());
    expect(field().value).toBe("admin");
    const rename = screen.getByRole("button", { name: "Rename" });
    expect(rename).toHaveProperty("disabled", true);
    fireEvent.change(field(), { target: { value: "Users" } });
    expect(screen.getByRole("status").textContent).toMatch(/already exists/);
    expect(rename).toHaveProperty("disabled", true);
    fireEvent.change(field(), { target: { value: "admins" } });
    expect(rename).toHaveProperty("disabled", false);
    expect(screen.getByLabelText("SQL to run").textContent).toBe(
      "RENAME TABLE `admin` TO `admins`;",
    );
    expect(screen.getByText(/Views, stored routines/)).toBeTruthy();
  });
  it("renames on Enter and shows a refusal from the database", async () => {
    const onRename = vi
      .fn()
      .mockRejectedValueOnce(new Error("Table 'admins' already exists"))
      .mockResolvedValueOnce(undefined);
    render(<RenameTableDialog {...base} onRename={onRename} />);
    fireEvent.change(field(), { target: { value: "admins" } });
    fireEvent.submit(field().closest("form")!);
    expect((await screen.findByRole("alert")).textContent).toContain(
      "already exists",
    );
    expect(field().disabled).toBe(false);
    fireEvent.submit(field().closest("form")!);
    await waitFor(() => expect(onRename).toHaveBeenCalledTimes(2));
    expect(onRename).toHaveBeenLastCalledWith("admins");
  });
  it("closes with Escape", () => {
    const onClose = vi.fn();
    render(
      <RenameTableDialog {...base} onRename={vi.fn()} onClose={onClose} />,
    );
    fireEvent.keyDown(field(), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
  });
});
