// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import ForeignKeyPicker from "./ForeignKeyPicker";
import * as api from "../lib/api";
import type { ForeignKeyInfo, QueryResult } from "../types";

vi.mock("../lib/api", () => ({ viewTable: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const key: ForeignKeyInfo = {
  name: "fk_customer",
  columns: ["customer_id"],
  referenced_table: { name: "customers", schema: "", kind: "table" },
  referenced_columns: ["id"],
};
const page = (
  number: number,
  rows: unknown[][],
  total = 1500,
): QueryResult => ({
  columns: ["id", "name", "email", "plan", "status", "avatar"],
  rows,
  pagination: { page: number, page_size: 1000, total_rows: total },
  execution_ms: 1,
  affected_rows: 0,
  truncated: false,
});
const row = (id: unknown, name: string) => [
  id,
  name,
  `${name}@example.com`,
  "Pro",
  "active",
  null,
];
function picker(onPick = vi.fn(), onClose = vi.fn()) {
  render(
    <ForeignKeyPicker
      connectionId="c1"
      database="shop"
      foreignKey={key}
      current={{ customer_id: 2 }}
      onPick={onPick}
      onClose={onClose}
    />,
  );
  return { onPick, onClose };
}
describe("ForeignKeyPicker", () => {
  it("shows the first 1,000 rows, loads more on request and highlights the current key", async () => {
    vi.mocked(api.viewTable)
      .mockResolvedValueOnce(page(1, [row(1, "Ann"), row(2, "Bob")]))
      .mockResolvedValueOnce(page(2, [row(3, "Cy")]));
    const { onPick } = picker();
    await screen.findByText("Bob");
    expect(screen.getByRole("status").textContent).toBe("2 of 1,500 rows");
    expect(
      screen.getByText("Bob").closest("tr")?.getAttribute("aria-selected"),
    ).toBe("true");
    // Key plus three extra columns are shown by default.
    expect(
      screen.getAllByRole("columnheader").map((header) => header.textContent),
    ).toEqual(["id", "name", "email", "plan"]);
    fireEvent.click(screen.getByRole("button", { name: "Show more" }));
    await screen.findByText("Cy");
    expect(api.viewTable).toHaveBeenLastCalledWith(
      "c1",
      "shop",
      key.referenced_table,
      2,
      1000,
      [],
      undefined,
    );
    expect(screen.getAllByRole("row")).toHaveLength(4);
    fireEvent.keyDown(screen.getByRole("grid"), { key: "ArrowDown" });
    fireEvent.click(screen.getByRole("button", { name: "Select" }));
    expect(onPick).toHaveBeenCalledWith({ customer_id: "3" });
  });
  it("searches the chosen display columns with bound filters and sorts by header", async () => {
    vi.mocked(api.viewTable).mockResolvedValue(page(1, [row(1, "Ann")], 1));
    picker();
    await screen.findByText("Ann");
    fireEvent.click(screen.getByText("Display columns"));
    fireEvent.click(screen.getByRole("checkbox", { name: "email" }));
    fireEvent.click(screen.getByRole("checkbox", { name: "status" }));
    expect(
      screen.getAllByRole("columnheader").map((header) => header.textContent),
    ).toEqual(["id", "name", "plan", "status"]);
    const search = screen.getByRole("searchbox", { name: "Search customers" });
    fireEvent.change(search, { target: { value: "50%_" } });
    // Enter searches at once instead of waiting for the typing pause.
    fireEvent.keyDown(search, { key: "Enter" });
    await waitFor(() =>
      expect(vi.mocked(api.viewTable).mock.lastCall?.[5]).toEqual(
        ["id", "name", "plan", "status"].map((column, index) => ({
          join: index ? "or" : "and",
          column,
          operator: "contains",
          value: "50%_",
        })),
      ),
    );
    const header = screen.getByRole("button", { name: "name" });
    fireEvent.click(header);
    await waitFor(() =>
      expect(vi.mocked(api.viewTable).mock.lastCall?.[6]).toEqual({
        column: "name",
        direction: "asc",
      }),
    );
    fireEvent.click(header);
    await waitFor(() =>
      expect(vi.mocked(api.viewTable).mock.lastCall?.[6]).toEqual({
        column: "name",
        direction: "desc",
      }),
    );
    expect(header.closest("th")?.getAttribute("aria-sort")).toBe("descending");
  });
  it("refuses binary keys, reports load errors and closes on Escape", async () => {
    vi.mocked(api.viewTable).mockResolvedValueOnce(
      page(1, [row({ hex: "00" }, "Raw")], 1),
    );
    const { onPick, onClose } = picker();
    fireEvent.doubleClick(await screen.findByText("Raw"));
    expect(onPick).not.toHaveBeenCalled();
    expect(screen.getByRole("alert").textContent).toContain("Binary");
    vi.mocked(api.viewTable).mockRejectedValueOnce(new Error("denied"));
    fireEvent.click(screen.getByRole("button", { name: "id" }));
    await waitFor(() =>
      expect(screen.getByRole("alert").textContent).toContain("denied"),
    );
    fireEvent.keyDown(within(screen.getByRole("dialog")).getByRole("grid"), {
      key: "Escape",
    });
    expect(onClose).toHaveBeenCalledOnce();
  });
});
