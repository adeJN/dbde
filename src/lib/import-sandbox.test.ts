import { afterEach, describe, expect, it, vi } from "vitest";
vi.mock("sql.js/dist/sql-wasm.wasm?url", () => ({
  default: "node_modules/sql.js/dist/sql-wasm.wasm",
}));
import {
  cancelImport,
  execute,
  importRowCount,
  importTarget,
  openImportFile,
  previewImport,
  runImport,
} from "./api";
import type { ImportRequest } from "./import";

// The sandbox reads the file through a hidden <input type="file">.
function pickFile(name: string, text: string) {
  const input = {
    type: "",
    accept: "",
    style: {} as Record<string, string>,
    files: [new File([text], name)],
    onchange: null as null | (() => void),
    oncancel: null as null | (() => void),
    remove: () => {},
    click: () => input.onchange?.(),
  };
  vi.stubGlobal("document", {
    createElement: () => input,
    body: { appendChild: () => {} },
  });
}
afterEach(() => {
  vi.unstubAllGlobals();
});
const table = { name: "import_people", schema: "", kind: "table" };
const request = (
  preview: { options: ImportRequest["options"] },
  mode: ImportRequest["mode"],
  continueOnError = false,
): ImportRequest => ({
  options: preview.options,
  mapping: [
    { source: "id", target: "id" },
    { source: "name", target: "name" },
  ],
  mode,
  continue_on_error: continueOnError,
  batch_rows: 500,
});
const people = async () =>
  (await execute("demo", "SELECT id, name FROM import_people ORDER BY id"))
    .rows;

describe("sandbox import", () => {
  it("imports CSV in a transaction with every mode", async () => {
    await execute(
      "demo",
      "CREATE TABLE import_people (id INTEGER PRIMARY KEY, name TEXT NOT NULL); INSERT INTO import_people VALUES (1, 'old');",
    );
    const target = await importTarget("demo", "workspace", table);
    expect(target.primary_keys).toEqual(["id"]);
    expect(target.columns[1]).toMatchObject({ name: "name", nullable: false });
    pickFile("people.csv", '﻿id,name\n1,"Ana, A"\n2,Bo\n');
    const preview = (await openImportFile())!;
    expect(preview.columns).toEqual(["id", "name"]);
    expect(preview.rows[0]).toEqual(["1", "Ana, A"]);
    // Append fails on the existing key and rolls back the whole file.
    await expect(
      runImport(
        "demo",
        "workspace",
        table,
        preview.import_id,
        request(preview, "append"),
      ),
    ).rejects.toThrow(/^Row 1: .*UNIQUE.*Nothing was imported\.$/);
    expect(await people()).toEqual([[1, "old"]]);
    const skipped = await runImport(
      "demo",
      "workspace",
      table,
      preview.import_id,
      request(preview, "append", true),
    );
    expect(skipped).toMatchObject({ inserted: 1, failed: 1 });
    const upsert = await runImport(
      "demo",
      "workspace",
      table,
      preview.import_id,
      request(preview, "upsert"),
    );
    expect(upsert).toMatchObject({ inserted: 0, updated: 2 });
    expect(await people()).toEqual([
      [1, "Ana, A"],
      [2, "Bo"],
    ]);
    const tsv = await previewImport(preview.import_id, {
      ...preview.options,
      format: "tsv",
      delimiter: "\t",
    });
    expect(tsv.columns).toEqual(["id,name"]);
    expect(await importRowCount("demo", "workspace", table)).toBe(2);
    pickFile(
      "more.json",
      '[{"id": 2, "name": "Bob"}, {"id": 9, "name": "Nine"}]',
    );
    const json = (await openImportFile())!;
    expect(json.options.format).toBe("json");
    const update = await runImport(
      "demo",
      "workspace",
      table,
      json.import_id,
      request(json, "update"),
    );
    expect(update).toMatchObject({ updated: 1, skipped: 1 });
    const copy = await runImport(
      "demo",
      "workspace",
      table,
      json.import_id,
      request(json, "copy"),
    );
    expect(copy).toMatchObject({ deleted: 2, inserted: 2 });
    expect(await people()).toEqual([
      [2, "Bob"],
      [9, "Nine"],
    ]);
    const cancelled = runImport(
      "demo",
      "workspace",
      table,
      preview.import_id,
      request(preview, "copy"),
    );
    await cancelImport(preview.import_id);
    expect(await cancelled).toBeNull();
    expect(await people()).toEqual([
      [2, "Bob"],
      [9, "Nine"],
    ]);
  });
  it("refuses Excel files with a clear message", async () => {
    pickFile("book.xlsx", "PK");
    await expect(openImportFile()).rejects.toThrow(/desktop app/);
  });
});
