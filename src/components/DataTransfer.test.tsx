// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import DataTransfer from "./DataTransfer";
import * as api from "../lib/api";
import type { Session } from "../types";
vi.mock("../lib/api", () => ({
  schema: vi.fn(),
  exportColumns: vi.fn(),
  applyChanges: vi.fn(),
}));
vi.mock("../lib/table-tools", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../lib/table-tools")>()),
  readTable: vi.fn().mockResolvedValue({
    columns: ["id", "name"],
    rows: [[1, "alpha"]],
    truncated: false,
    execution_ms: 0,
    affected_rows: 0,
  }),
}));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const source: Session = {
  id: "source",
  config: {
    id: "a",
    name: "Local",
    driver: "mysql",
    host: "localhost",
    port: 3306,
    username: "root",
    database: "source",
    ssl_mode: "disable",
    file_path: "",
  },
  databases: ["source"],
};
const target: Session = {
  id: "target",
  config: {
    ...source.config,
    id: "b",
    name: "Remote",
    host: "remote.example",
    database: "destination",
  },
  databases: ["destination"],
};
const tables = [
  { name: "a", schema: "source", kind: "table" },
  { name: "b", schema: "source", kind: "table" },
];
it("transfers several tables across connections and retries only tables that failed", async () => {
  vi.mocked(api.schema).mockResolvedValue({
    database: "destination",
    tables: tables.map((t) => ({ ...t, schema: "destination" })),
  });
  vi.mocked(api.exportColumns).mockResolvedValue(["id", "name"]);
  vi.mocked(api.applyChanges)
    .mockResolvedValueOnce(1)
    .mockRejectedValueOnce(new Error("duplicate key"))
    .mockResolvedValueOnce(1);
  const onBusy = vi.fn(),
    onChanged = vi.fn();
  render(
    <DataTransfer
      session={source}
      database="source"
      tables={tables}
      sessions={[source, target]}
      onChanged={onChanged}
      onBusy={onBusy}
    />,
  );
  await waitFor(() =>
    expect(
      (screen.getByLabelText("Destination for a") as HTMLSelectElement).value,
    ).toBe('["destination","a"]'),
  );
  fireEvent.click(screen.getByRole("button", { name: "Select all" }));
  fireEvent.click(
    screen.getByRole("checkbox", {
      name: "Append records to the selected destination tables",
    }),
  );
  fireEvent.click(screen.getByRole("button", { name: "Transfer 2 tables" }));
  await screen.findByRole("alert");
  expect(api.applyChanges).toHaveBeenCalledTimes(2);
  expect(onChanged).toHaveBeenCalled();
  await waitFor(() => expect(onBusy).toHaveBeenLastCalledWith(false));
  fireEvent.click(screen.getByRole("button", { name: "Transfer 2 tables" }));
  await waitFor(() => expect(api.applyChanges).toHaveBeenCalledTimes(3));
  expect(
    vi
      .mocked(api.applyChanges)
      .mock.calls.map((call) => [call[0], call[1].table.name]),
  ).toEqual([
    ["target", "a"],
    ["target", "b"],
    ["target", "b"],
  ]);
});
