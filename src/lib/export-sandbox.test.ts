import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("sql.js/dist/sql-wasm.wasm?url", () => ({
  default: "node_modules/sql.js/dist/sql-wasm.wasm",
}));
import { cancelExport, execute, exportRows, exportTable } from "./api";
import { defaultExportOptions } from "./export";

// The browser sandbox builds the file in memory and hands it to a download link.
function captureDownloads() {
  const files: { name: string; blob: Blob }[] = [];
  let pending: Blob | undefined;
  vi.stubGlobal("document", {
    createElement: () => {
      const link = {
        href: "",
        download: "",
        click: () => files.push({ name: link.download, blob: pending! }),
      };
      return link;
    },
  });
  vi.spyOn(URL, "createObjectURL").mockImplementation((blob) => {
    pending = blob as Blob;
    return "blob:test";
  });
  vi.spyOn(URL, "revokeObjectURL").mockImplementation(() => {});
  return files;
}
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});
const table = { name: "export_people", schema: "", kind: "table" };
describe("sandbox export", () => {
  it("exports the filtered, sorted table as CSV and the whole table as SQL", async () => {
    await execute(
      "demo",
      "CREATE TABLE export_people (id INTEGER PRIMARY KEY, name TEXT, note TEXT, data BLOB); INSERT INTO export_people VALUES (1, 'Ana, \"A\"', NULL, x'00ff'), (2, '=1+1', 'x', NULL), (3, 'Zed', 'y', NULL);",
    );
    const files = captureDownloads();
    const progress = vi.fn();
    const summary = await exportTable(
      "demo",
      "workspace",
      table,
      { ...defaultExportOptions(["name", "data"]), bom: false },
      {
        filters: [{ column: "id", operator: "not_equals", value: "3" }],
        sort: { column: "id", direction: "desc" },
      },
      "export-1",
      progress,
    );
    expect(summary).toEqual({
      path: "export_people.csv",
      rows: 2,
      sheets: 1,
      truncated_cells: 0,
    });
    expect(progress).toHaveBeenLastCalledWith(2);
    expect(await files[0].blob.text()).toBe(
      'name,data\r\n\'=1+1,\r\n"Ana, ""A""",0x00ff\r\n',
    );
    await exportTable(
      "demo",
      "workspace",
      table,
      {
        ...defaultExportOptions(["id", "name"]),
        format: "sql",
        create_table: true,
      },
      {},
      "export-2",
    );
    const sql = await files[1].blob.text();
    expect(files[1].name).toBe("export_people.sql");
    expect(sql).toMatch(/^CREATE TABLE export_people/);
    expect(sql).toContain(
      `INSERT INTO "export_people" ("id", "name") VALUES\n  (1, 'Ana, "A"'),\n  (2, '=1+1'),\n  (3, 'Zed');`,
    );
    await expect(cancelExport("export-2")).resolves.toBeUndefined();
  });
  it("exports fetched rows as JSON and explains that Excel needs the desktop app", async () => {
    const files = captureDownloads();
    const options = {
      ...defaultExportOptions(["n", "label"]),
      format: "json" as const,
    };
    await exportRows(
      "demo",
      undefined,
      undefined,
      options,
      [
        [1, "a"],
        [2, null],
      ],
      "x",
    );
    expect(files[0].name).toBe("dbde-results.json");
    expect(JSON.parse(await files[0].blob.text())).toEqual([
      { n: 1, label: "a" },
      { n: 2, label: null },
    ]);
    await expect(
      exportRows(
        "demo",
        undefined,
        undefined,
        { ...options, format: "xlsx" },
        [],
        "y",
      ),
    ).rejects.toThrow(/Excel export requires the desktop app/);
  });
});
