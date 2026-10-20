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
const api = vi.hoisted(() => ({
  desktop: true,
  importTarget: vi.fn(),
  openImportFile: vi.fn(),
  previewImport: vi.fn(),
  closeImport: vi.fn(),
  importRowCount: vi.fn(),
  runImport: vi.fn(),
  cancelImport: vi.fn(),
}));
vi.mock("../lib/api", () => api);
import ImportDialog from "./ImportDialog";
import type { ImportPreview, ImportSummary } from "../lib/import";

const table = { name: "customers", schema: "", kind: "table" };
const target = {
  columns: [
    {
      name: "id",
      data_type: "INTEGER",
      nullable: false,
      has_default: true,
      generated: false,
    },
    {
      name: "email",
      data_type: "TEXT",
      nullable: false,
      has_default: false,
      generated: false,
    },
    {
      name: "name",
      data_type: "TEXT",
      nullable: true,
      has_default: false,
      generated: false,
    },
  ],
  primary_keys: ["id"],
  transactional: true,
};
const preview: ImportPreview = {
  import_id: "imp1",
  file_name: "people.csv",
  file_size: 2048,
  options: {
    format: "csv",
    delimiter: ",",
    quote: '"',
    header: true,
    null_text: "",
  },
  sheets: [],
  columns: ["ID", "Email", "Nickname"],
  rows: [["1", "a@x", null]],
  row_errors: [],
  estimated_rows: 1000,
  exact_rows: false,
};
const summary: ImportSummary = {
  rows: 3,
  inserted: 2,
  updated: 0,
  skipped: 0,
  failed: 1,
  deleted: 0,
  errors: [{ row: 2, message: "NOT NULL constraint failed: customers.email" }],
  more_errors: 0,
};
beforeEach(() => {
  api.desktop = true;
  api.importTarget.mockReset().mockResolvedValue(target);
  api.openImportFile.mockReset().mockResolvedValue(preview);
  api.previewImport.mockReset();
  api.closeImport.mockReset().mockResolvedValue(undefined);
  api.importRowCount.mockReset().mockResolvedValue(42);
  api.runImport.mockReset().mockResolvedValue(summary);
  api.cancelImport.mockReset().mockResolvedValue(undefined);
});
afterEach(cleanup);
function renderDialog(confirmed = true, prepared = true) {
  const confirm = vi.fn().mockResolvedValue(confirmed);
  const prepare = vi.fn().mockResolvedValue(prepared);
  const onImported = vi.fn();
  const onClose = vi.fn();
  render(
    <ImportDialog
      request={{
        connectionId: "local",
        database: "main",
        driver: "sqlite",
        table,
      }}
      confirm={confirm}
      prepare={prepare}
      onImported={onImported}
      onClose={onClose}
    />,
  );
  return { confirm, prepare, onImported, onClose };
}
const button = (name: RegExp | string) => screen.getByRole("button", { name });
async function openFile() {
  await waitFor(() => expect(api.importTarget).toHaveBeenCalled());
  fireEvent.click(button(/Choose file/));
  await screen.findByText(/people\.csv/);
}

describe("import wizard", () => {
  it("previews the file, auto-maps columns and flags unmapped required columns", async () => {
    renderDialog();
    expect(
      screen.getByRole("dialog", { name: /Import into customers/ }),
    ).toBeTruthy();
    expect((button("Next") as HTMLButtonElement).disabled).toBe(true);
    await openFile();
    expect(screen.getByText(/about 1,000 rows/)).toBeTruthy();
    const grid = within(screen.getByLabelText("File preview"));
    expect(grid.getByText("a@x")).toBeTruthy();
    expect(grid.getByText("NULL")).toBeTruthy();
    fireEvent.click(button("Next"));
    const id = screen.getByRole("combobox", {
      name: "Target for ID",
    }) as HTMLSelectElement;
    const email = screen.getByRole("combobox", {
      name: "Target for Email",
    }) as HTMLSelectElement;
    const nick = screen.getByRole("combobox", {
      name: "Target for Nickname",
    }) as HTMLSelectElement;
    expect([id.value, email.value, nick.value]).toEqual(["id", "email", ""]);
    expect(screen.queryByText(/Required column/)).toBeNull();
    fireEvent.change(email, { target: { value: "" } });
    expect(screen.getByRole("alert").textContent).toMatch(
      /Required column not mapped.*email/,
    );
    fireEvent.change(nick, { target: { value: "email" } });
    expect(screen.queryByText(/Required column/)).toBeNull();
    expect(screen.getAllByText("TEXT · NOT NULL").length).toBe(1);
  });
  it("re-parses when the delimiter or header option changes", async () => {
    api.previewImport.mockResolvedValue({
      ...preview,
      columns: ["Column 1"],
      options: { ...preview.options, delimiter: ";", header: false },
    });
    renderDialog();
    await openFile();
    fireEvent.change(screen.getByRole("combobox", { name: "Delimiter" }), {
      target: { value: ";" },
    });
    await waitFor(() =>
      expect(api.previewImport).toHaveBeenCalledWith(
        "imp1",
        expect.objectContaining({ delimiter: ";" }),
      ),
    );
    await screen.findByText("Column 1");
  });
  it("confirms Copy with the row count, runs the guards, shows progress and the summary", async () => {
    let finish: (value: ImportSummary) => void = () => {};
    api.runImport.mockImplementation((_c, _d, _t, _id, _r, progress) => {
      progress(500);
      return new Promise((resolve) => (finish = resolve));
    });
    const { confirm, prepare, onImported } = renderDialog();
    await openFile();
    fireEvent.click(button("Next"));
    fireEvent.click(button("Next"));
    fireEvent.click(screen.getByRole("radio", { name: /^Copy/ }));
    fireEvent.click(
      screen.getByRole("checkbox", { name: /Continue on error/ }),
    );
    fireEvent.click(button(/^Import$/));
    await waitFor(() => expect(confirm).toHaveBeenCalled());
    expect(api.importRowCount).toHaveBeenCalledWith("local", "main", table);
    expect(confirm.mock.calls[0][0]).toMatchObject({
      title: "Replace every row in customers?",
      details: ["customers: 42 rows will be deleted"],
    });
    expect(confirm.mock.calls[0][0].body).toMatch(
      /deletes 42 existing rows in main\.customers/,
    );
    await waitFor(() => expect(prepare).toHaveBeenCalled());
    await screen.findByText(/500 rows processed of about 1,000/);
    expect(api.runImport).toHaveBeenCalledWith(
      "local",
      "main",
      table,
      "imp1",
      {
        options: preview.options,
        mapping: [
          { source: "ID", target: "id" },
          { source: "Email", target: "email" },
        ],
        mode: "copy",
        continue_on_error: true,
        batch_rows: 500,
      },
      expect.any(Function),
    );
    fireEvent.click(button("Cancel import"));
    expect(api.cancelImport).toHaveBeenCalledWith("imp1");
    finish(summary);
    await screen.findByText("Inserted 2 rows, 1 row failed.");
    expect(onImported).toHaveBeenCalledWith(summary);
    const issues = within(screen.getByLabelText("Row issues"));
    expect(
      issues.getByText("NOT NULL constraint failed: customers.email"),
    ).toBeTruthy();
  });
  it("does not import when Copy is declined or the guards cancel", async () => {
    renderDialog(false);
    await openFile();
    fireEvent.click(button("Next"));
    fireEvent.click(button("Next"));
    fireEvent.click(screen.getByRole("radio", { name: /^Copy/ }));
    fireEvent.click(button(/^Import$/));
    await waitFor(() => expect(api.importRowCount).toHaveBeenCalled());
    expect(api.runImport).not.toHaveBeenCalled();
    cleanup();
    const { prepare } = renderDialog(true, false);
    await openFile();
    fireEvent.click(button("Next"));
    fireEvent.click(button("Next"));
    fireEvent.click(button(/^Import$/));
    await waitFor(() => expect(prepare).toHaveBeenCalled());
    expect(
      await screen.findByText(/Import cancelled\. Unsaved changes/),
    ).toBeTruthy();
    expect(api.runImport).not.toHaveBeenCalled();
  });
  it("disables Update without a primary key and reports a cancelled import", async () => {
    api.importTarget.mockResolvedValue({ ...target, primary_keys: [] });
    api.runImport.mockResolvedValue(null);
    renderDialog();
    await openFile();
    fireEvent.click(button("Next"));
    fireEvent.click(button("Next"));
    expect(
      (screen.getByRole("radio", { name: /^Update/ }) as HTMLInputElement)
        .disabled,
    ).toBe(true);
    expect(
      (
        screen.getByRole("radio", {
          name: /^Append\/Update/,
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
    fireEvent.click(button(/^Import$/));
    expect(
      await screen.findByText("Import cancelled. Nothing was imported."),
    ).toBeTruthy();
  });
  it("closes the opened file when the wizard closes", async () => {
    const { onClose } = renderDialog();
    await openFile();
    fireEvent.keyDown(screen.getByRole("dialog"), { key: "Escape" });
    expect(onClose).toHaveBeenCalled();
    cleanup();
    expect(api.closeImport).toHaveBeenCalledWith("imp1");
  });
});
