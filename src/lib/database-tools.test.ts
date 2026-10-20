import { describe, expect, it, vi } from "vitest";
vi.mock("sql.js/dist/sql-wasm.wasm?url", () => ({
  default: "node_modules/sql.js/dist/sql-wasm.wasm",
}));
import * as api from "./api";
import {
  databaseFileName,
  dumpDatabase,
  sharedDatabaseProfile,
} from "./database-tools";

describe("database menu utilities", () => {
  it("shares only explicit connection fields without credentials or table data", () => {
    const config = {
      ...api.demoConfig,
      password: "secret-password",
      token: "secret-token",
    };
    const json = sharedDatabaseProfile(config, "selected_database");
    expect(json).not.toMatch(/password|token|secret/);
    expect(JSON.parse(json).connection.database).toBe("selected_database");
    expect(JSON.parse(json).format).toBe("dbde-connection");
    expect(databaseFileName("a/b\\c", "sql")).toBe("a_b_c.sql");
  });
  it("restores the whole SQLite database with binary data, generated columns, foreign keys and deferred triggers", async () => {
    await api.execute(
      "demo",
      "CREATE TABLE export_parent (id INTEGER PRIMARY KEY, name TEXT); CREATE TABLE export_child (id INTEGER PRIMARY KEY, parent_id INTEGER REFERENCES export_parent(id), payload BLOB, label TEXT GENERATED ALWAYS AS ('OK') STORED); CREATE TABLE export_audit (message TEXT); CREATE TRIGGER export_child_audit AFTER INSERT ON export_child BEGIN INSERT INTO export_audit VALUES ('inserted'); END; INSERT INTO export_parent VALUES (1, 'Ada'); INSERT INTO export_child (id, parent_id, payload) VALUES (1, 1, X'00ff');",
    );
    const session = { id: "demo", config: api.demoConfig };
    const sql = await dumpDatabase(session, "workspace", true);
    expect(sql).toContain("X'00ff'");
    const { default: initSqlJs } = await import("sql.js");
    const SQL = await initSqlJs({
      locateFile: () => "node_modules/sql.js/dist/sql-wasm.wasm",
    });
    const restored = new SQL.Database();
    try {
      restored.run(sql);
      expect(
        restored.exec("SELECT hex(payload), label FROM export_child")[0].values,
      ).toEqual([["00FF", "OK"]]);
      expect(
        restored.exec("SELECT COUNT(*) FROM export_audit")[0].values,
      ).toEqual([[1]]);
      restored.run("INSERT INTO export_child (id, parent_id) VALUES (2, 1)");
      expect(
        restored.exec("SELECT COUNT(*) FROM export_audit")[0].values,
      ).toEqual([[2]]);
      expect(restored.exec("PRAGMA foreign_key_check")).toEqual([]);
    } finally {
      restored.close();
    }
    const structure = await dumpDatabase(session, "workspace", false);
    expect(structure).toContain("CREATE TABLE export_parent");
    expect(structure).not.toContain('INSERT INTO "export_parent"');
    await api.execute(
      "demo",
      "DROP TABLE export_child; DROP TABLE export_parent; DROP TABLE export_audit;",
    );
  });
});
