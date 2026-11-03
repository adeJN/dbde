// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import PasteTablesDialog from "./PasteTablesDialog";
import type { Session } from "../types";
const api = vi.hoisted(() => ({
  desktop: false,
  schema: vi.fn(),
  pasteTable: vi.fn(),
  pasteTables: vi.fn(),
}));
vi.mock("../lib/api", () => api);
afterEach(() => {
  cleanup();
  vi.resetAllMocks();
  api.desktop = false;
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
  expect(
    screen
      .getByRole("progressbar", { name: "Tables copied" })
      .getAttribute("value"),
  ).toBe("1");
  expect(screen.getByText("Copy interrupted")).toBeTruthy();
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

it("shows real completed-table progress while each copy is pending", async () => {
  api.schema.mockResolvedValue({ database: "dest", tables: [] });
  let finishFirst!: () => void;
  let finishSecond!: () => void;
  api.pasteTable
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishFirst = resolve;
        }),
    )
    .mockImplementationOnce(
      () =>
        new Promise<void>((resolve) => {
          finishSecond = resolve;
        }),
    );
  const onDone = vi.fn();
  render(
    <PasteTablesDialog
      source={{
        connectionId: "source",
        database: "source",
        text: "alpha\nbeta",
        tables: ["alpha", "beta"].map((name) => ({
          name,
          schema: "source",
          kind: "table",
        })),
      }}
      target={target}
      database="dest"
      onClose={vi.fn()}
      onDone={onDone}
    />,
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Paste tables" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Paste tables" }));
  expect(
    screen
      .getByRole("progressbar", { name: "Tables copied" })
      .getAttribute("value"),
  ).toBe("0");
  expect(screen.getByText("0 of 2 tables completed")).toBeTruthy();
  expect(screen.getByText("alpha → alpha")).toBeTruthy();
  expect(onDone).not.toHaveBeenCalled();
  await act(async () => finishFirst());
  expect(
    screen
      .getByRole("progressbar", { name: "Tables copied" })
      .getAttribute("value"),
  ).toBe("1");
  expect(screen.getByText("50%")).toBeTruthy();
  expect(screen.getByText("beta → beta")).toBeTruthy();
  fireEvent.click(screen.getByRole("button", { name: "View log" }));
  await act(async () => finishSecond());
  expect(
    screen
      .getByRole("progressbar", { name: "Tables copied" })
      .getAttribute("value"),
  ).toBe("2");
  expect(screen.getByText("100%")).toBeTruthy();
  expect(onDone).toHaveBeenCalledWith(2);
});

it("prepares the whole MySQL group and waits for relationship validation before marking tables copied", async () => {
  api.desktop = true;
  api.schema.mockResolvedValue({ database: "dest", tables: [] });
  let finish!: () => void;
  let update!: (progress: {
    stage: string;
    tables_copied: number;
    phase: string;
    table_index?: number;
  }) => void;
  api.pasteTables.mockImplementation((...args: unknown[]) => {
    update = args[7] as typeof update;
    return new Promise<void>((resolve) => {
      finish = resolve;
    });
  });
  const onDone = vi.fn();
  render(
    <PasteTablesDialog
      source={{
        connectionId: "source",
        database: "source",
        text: "child\nparent",
        tables: ["child", "parent"].map((name) => ({
          name,
          schema: "source",
          kind: "table",
        })),
      }}
      target={target}
      database="dest"
      onClose={vi.fn()}
      onDone={onDone}
    />,
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Paste tables" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Paste tables" }));
  expect(api.pasteTable).not.toHaveBeenCalled();
  expect(api.pasteTables.mock.calls[0][4]).toEqual([
    {
      table: { name: "child", schema: "source", kind: "table" },
      target: { name: "child", schema: "dest", kind: "table" },
    },
    {
      table: { name: "parent", schema: "source", kind: "table" },
      target: { name: "parent", schema: "dest", kind: "table" },
    },
  ]);
  act(() =>
    update({
      stage: "Validating foreign key child.parent_id",
      tables_copied: 2,
      phase: "relations",
    }),
  );
  expect(screen.getByText("50%")).toBeTruthy();
  expect(screen.queryByText("Copy complete")).toBeNull();
  expect(onDone).not.toHaveBeenCalled();
  expect(screen.getByText(/2 of 2 tables prepared/)).toBeTruthy();
  await act(async () => finish());
  expect(screen.getByText("100%")).toBeTruthy();
  expect(onDone).toHaveBeenCalledWith(2);
});
it("keeps a failed group retryable without marking staged tables as completed", async () => {
  api.desktop = true;
  api.schema.mockResolvedValue({ database: "dest", tables: [] });
  api.pasteTables.mockRejectedValueOnce(
    new Error("Copy dependency missing: include table source.parent"),
  );
  const onDone = vi.fn();
  render(
    <PasteTablesDialog
      source={{
        connectionId: "source",
        database: "source",
        text: "child",
        tables: [{ name: "child", schema: "source", kind: "table" }],
      }}
      target={target}
      database="dest"
      onClose={vi.fn()}
      onDone={onDone}
    />,
  );
  await waitFor(() =>
    expect(
      screen
        .getByRole("button", { name: "Paste tables" })
        .hasAttribute("disabled"),
    ).toBe(false),
  );
  fireEvent.click(screen.getByRole("button", { name: "Paste tables" }));
  expect((await screen.findByRole("alert")).textContent).toContain(
    "include table source.parent",
  );
  expect(onDone).not.toHaveBeenCalled();
  expect(
    (
      screen.getByRole("textbox", {
        name: "Target name for child",
      }) as HTMLInputElement
    ).disabled,
  ).toBe(false);
});
