// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import DdlDialog from "./DdlDialog";
afterEach(cleanup);
const props = {
  table: { name: "admin", schema: "", kind: "table" },
  database: "test buat",
  driver: "mysql" as const,
  ddl: "CREATE TABLE `admin` (\n  `idadmin` int(11) NOT NULL\n);",
  onCopy: vi.fn().mockResolvedValue(undefined),
  onOpenInEditor: vi.fn(),
  onSave: vi.fn().mockResolvedValue(null),
  onClose: vi.fn(),
};
describe("DDL dialog", () => {
  it("shows highlighted, read-only DDL and closes with Escape, restoring focus", () => {
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    const onClose = vi.fn();
    const { unmount } = render(<DdlDialog {...props} onClose={onClose} />);
    const code = screen.getByLabelText("Definition of admin");
    expect(code.textContent).toBe(props.ddl);
    expect(code.querySelector(".sql-keyword")?.textContent).toBe("CREATE");
    expect(code.querySelector(".sql-identifier")?.textContent).toBe("`admin`");
    expect(document.activeElement).toBe(code);
    expect(screen.queryByText(/Triggers, comments/)).toBeNull();
    expect(screen.getByText(/test buat · table · read-only/)).toBeTruthy();
    fireEvent.keyDown(code, { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    unmount();
    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
  it("reports copy failures and cancelled saves", async () => {
    render(
      <DdlDialog
        {...props}
        onCopy={vi.fn().mockRejectedValue(new Error("Clipboard denied"))}
      />,
    );
    fireEvent.click(screen.getByRole("button", { name: /Copy/ }));
    expect((await screen.findByRole("alert")).textContent).toContain(
      "Clipboard denied",
    );
    fireEvent.click(screen.getByRole("button", { name: /Save \.sql/ }));
    await waitFor(() =>
      expect(screen.getByRole("status").textContent).toBe("Save cancelled."),
    );
  });
  it("hands the DDL to the SQL editor only when asked", () => {
    const onOpenInEditor = vi.fn();
    render(<DdlDialog {...props} onOpenInEditor={onOpenInEditor} />);
    expect(onOpenInEditor).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: /Open in SQL Editor/ }));
    expect(onOpenInEditor).toHaveBeenCalledWith(props.ddl);
  });
});
