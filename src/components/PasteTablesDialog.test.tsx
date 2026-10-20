// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import PasteTablesDialog from "./PasteTablesDialog";
import type { Session } from "../types";
const api = vi.hoisted(() => ({ schema: vi.fn(), pasteTable: vi.fn() }));
vi.mock("../lib/api", () => api);
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
});
const target: Session = {
  id: "target",
  config: {
    id: "profile",
    name: "Local",
    driver: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    database: "dest",
    ssl_mode: "disable",
    file_path: "",
  },
};
it("keeps successful copies on partial failure and retries only remaining tables", async () => {
  const tables = ["alpha", "beta"].map((name) => ({
    name,
    schema: "source",
    kind: "table",
  }));
  api.schema.mockResolvedValue({ database: "dest", tables: [tables[0]] });
  api.pasteTable
    .mockResolvedValueOnce(undefined)
    .mockRejectedValueOnce(new Error("Access denied"))
    .mockResolvedValueOnce(undefined);
  const onDone = vi.fn();
  render(
    <PasteTablesDialog
      source={{
        connectionId: "source",
        database: "source",
        tables,
        text: "alpha\nbeta",
      }}
      target={target}
      database="dest"
      onClose={vi.fn()}
      onDone={onDone}
    />,
  );
  await screen.findByRole("textbox", { name: "Target name for alpha" });
  expect(
    (
      screen.getByRole("textbox", {
        name: "Target name for alpha",
      }) as HTMLInputElement
    ).value,
  ).toBe("alpha_copy");
  fireEvent.click(screen.getByRole("button", { name: "Paste tables" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "1 of 2 tables copied",
  );
  expect(onDone).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Paste tables" }));
  await waitFor(() => expect(onDone).toHaveBeenCalledWith(2));
  expect(api.pasteTable).toHaveBeenCalledTimes(3);
  expect(api.pasteTable.mock.calls[0][5]).toEqual({
    name: "alpha_copy",
    schema: "dest",
    kind: "table",
  });
  expect(api.pasteTable.mock.calls[2][2].name).toBe("beta");
});
