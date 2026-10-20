import { describe, expect, it, vi } from "vitest";
vi.mock("sql.js/dist/sql-wasm.wasm?url", () => ({
  default: "node_modules/sql.js/dist/sql-wasm.wasm",
}));
import * as api from "./api";
import { dumpTable, mappedRecords, readTable } from "./table-tools";
const table = (name: string) => ({ name, schema: "", kind: "table" });
describe("sidebar table operations", () => {
  it("copies structure, generated columns and indexes without overwriting; empty preserves counters, truncate resets them", async () => {
    await api.execute(
      "demo",
      'CREATE TABLE "source(a" (id INTEGER PRIMARY KEY AUTOINCREMENT, name TEXT NOT NULL, upper_name TEXT GENERATED ALWAYS AS (upper(name)) STORED); CREATE UNIQUE INDEX "idx(a" ON "source(a" (name); INSERT INTO "source(a" (name) VALUES (\'Ada\');',
    );
    await api.copyTable(
      "demo",
      "workspace",
      table("source(a"),
      table("copy(a"),
      true,
    );
    expect((await api.execute("demo", 'SELECT * FROM "copy(a"')).rows).toEqual([
      [1, "Ada", "ADA"],
    ]);
    await expect(
      api.execute("demo", "INSERT INTO \"copy(a\" (name) VALUES ('Ada')"),
    ).rejects.toThrow();
    await expect(
      api.copyTable(
        "demo",
        "workspace",
        table("source(a"),
        table("copy(a"),
        true,
      ),
    ).rejects.toThrow();
    await api.clearTable("demo", "workspace", table("copy(a"), false);
    await api.execute("demo", "INSERT INTO \"copy(a\" (name) VALUES ('B')");
    expect((await api.execute("demo", 'SELECT id FROM "copy(a"')).rows).toEqual(
      [[2]],
    );
    await api.clearTable("demo", "workspace", table("copy(a"), true);
    await api.execute("demo", "INSERT INTO \"copy(a\" (name) VALUES ('C')");
    expect((await api.execute("demo", 'SELECT id FROM "copy(a"')).rows).toEqual(
      [[1]],
    );
    await api.copyTable(
      "demo",
      "workspace",
      table("source(a"),
      table("emptycopy"),
      false,
    );
    expect((await api.execute("demo", "SELECT * FROM emptycopy")).rows).toEqual(
      [],
    );
    await api.execute(
      "demo",
      'DROP TABLE "source(a"; DROP TABLE "copy(a"; DROP TABLE emptycopy;',
    );
  });
  it("exports every page, excludes generated values and produces a restorable SQL dump", async () => {
    await api.execute(
      "demo",
      "CREATE TABLE dump_test (id INTEGER PRIMARY KEY, name TEXT, label TEXT GENERATED ALWAYS AS (upper(name)) STORED); WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n < 6005) INSERT INTO dump_test (id, name) SELECT n, 'row ' || n FROM seq;",
    );
    const result = await readTable(
      "demo",
      "workspace",
      table("dump_test"),
      "sqlite",
      100000,
    );
    expect(result.rows).toHaveLength(6005);
    expect(result.columns).toEqual(["id", "name"]);
    await expect(
      readTable("demo", "workspace", table("dump_test"), "sqlite", 1000),
    ).rejects.toThrow("1,000 records");
    const dump = await dumpTable(
      "demo",
      "workspace",
      table("dump_test"),
      "sqlite",
      true,
    );
    await api.execute("demo", "DROP TABLE dump_test");
    await api.execute("demo", dump);
    expect(
      (await api.execute("demo", "SELECT COUNT(*) FROM dump_test")).rows,
    ).toEqual([[6005]]);
    expect(
      (await api.execute("demo", "SELECT label FROM dump_test WHERE id = 6005"))
        .rows,
    ).toEqual([["ROW 6005"]]);
    await api.execute("demo", "DROP TABLE dump_test");
  });
  it("maps columns explicitly and cancels the whole transfer if any row conflicts", async () => {
    await api.execute(
      "demo",
      "CREATE TABLE transfer_source (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO transfer_source VALUES (1, 'Ada'), (2, 'Bob'); CREATE TABLE transfer_target (id INTEGER PRIMARY KEY, label TEXT UNIQUE); INSERT INTO transfer_target VALUES (1, 'Bob');",
    );
    const result = await readTable(
      "demo",
      "workspace",
      table("transfer_source"),
      "sqlite",
      5000,
    );
    const changes = mappedRecords(result, [
      { source: "name", target: "label" },
    ]);
    await expect(
      api.applyChanges(
        "demo",
        {
          table: table("transfer_target"),
          database: "workspace",
          primary_keys: [],
        },
        changes,
      ),
    ).rejects.toThrow("Nothing was saved");
    expect(
      (await api.execute("demo", "SELECT * FROM transfer_target")).rows,
    ).toEqual([[1, "Bob"]]);
    expect(() =>
      mappedRecords(result, [
        { source: "name", target: "label" },
        { source: "id", target: "label" },
      ]),
    ).toThrow("unique target");
    await api.execute(
      "demo",
      "DROP TABLE transfer_source; DROP TABLE transfer_target;",
    );
  });
});

it("keeps SQLite BLOB bytes intact in SQL dumps", async () => {
  await api.execute(
    "demo",
    "CREATE TABLE dump_blob (id INTEGER PRIMARY KEY, payload BLOB); INSERT INTO dump_blob VALUES (1, X'00ff42');",
  );
  const dump = await dumpTable(
    "demo",
    "workspace",
    table("dump_blob"),
    "sqlite",
    true,
  );
  expect(dump).toContain("X'00ff42'");
  await api.execute("demo", "DROP TABLE dump_blob");
  await api.execute("demo", dump);
  expect(
    (await api.execute("demo", "SELECT hex(payload) FROM dump_blob")).rows,
  ).toEqual([["00FF42"]]);
  await api.execute("demo", "DROP TABLE dump_blob");
});

it("defers BLOB values in quick mode and loads the original record only on request", async () => {
  await api.execute(
    "demo",
    "CREATE TABLE quick_blob (id INTEGER PRIMARY KEY, payload BLOB, label TEXT GENERATED ALWAYS AS ('OK') STORED); INSERT INTO quick_blob (id, payload) VALUES (1, X'00ff');",
  );
  const quick = await api.viewTable(
    "demo",
    "workspace",
    table("quick_blob"),
    1,
    1000,
    [],
    undefined,
    true,
  );
  expect(quick.source?.quick).toBe(true);
  expect(quick.rows).toEqual([[1, { deferred: true }, "OK"]]);
  const full = await api.loadRecord(
    "demo",
    quick.source!,
    quick.rows[0],
    quick.columns,
  );
  expect(full[1]).toEqual(new Uint8Array([0, 255]));
  expect(full[2]).toBe("OK");
  expect(
    (await api.viewTable("demo", "workspace", table("quick_blob"))).rows[0][2],
  ).toBe("OK");
  await api.execute(
    "demo",
    "DROP TABLE quick_blob; CREATE TABLE no_key (payload BLOB)",
  );
  await expect(
    api.viewTable(
      "demo",
      "workspace",
      table("no_key"),
      1,
      1000,
      [],
      undefined,
      true,
    ),
  ).rejects.toThrow("requires a primary key");
  await api.execute("demo", "DROP TABLE no_key");
});
