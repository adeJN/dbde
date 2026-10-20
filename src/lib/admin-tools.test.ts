import { describe, expect, it } from "vitest";
import {
  accountSql,
  builderSql,
  grantsSql,
  killQuerySql,
  monitorSql,
  privilegeSql,
  roleSql,
} from "./admin-tools";
const a = { name: "orders", schema: "shop", kind: "table" },
  b = { name: "customers", schema: "shop", kind: "table" };
const columns = {
  ['["shop","orders"]']: ["id", "customer_id"],
  ['["shop","customers"]']: ["id", "name"],
};
describe("server administration SQL", () => {
  it("uses dialect-specific monitoring and query cancellation", () => {
    expect(monitorSql("mysql", "Processes")).toBe("SHOW FULL PROCESSLIST;");
    expect(monitorSql("postgres", "Variables")).toContain("pg_settings");
    expect(killQuerySql("postgres", "12")).toBe(
      "SELECT pg_cancel_backend(12);",
    );
    expect(killQuerySql("mysql", "12")).toBe("KILL QUERY 12;");
    for (const id of [
      "1;DROP DATABASE x",
      "0",
      "-1",
      "NaN",
      "9007199254740993",
    ])
      expect(() => killQuerySql("mysql", id)).toThrow();
    expect(() => killQuerySql("sqlite", "1")).toThrow();
  });
  it("quotes accounts and identifiers and only emits supported privilege tokens", () => {
    expect(accountSql("mysql", "o'brien", "localhost")).toBe(
      "'o''brien'@'localhost'",
    );
    expect(() => accountSql("mysql", "x\\y")).toThrow();
    expect(
      privilegeSql(
        "mysql",
        "GRANT",
        "reader",
        "localhost",
        "my db",
        "",
        "order",
        "SELECT",
      ),
    ).toBe("GRANT SELECT ON `my db`.`order` TO 'reader'@'localhost';");
    expect(
      privilegeSql(
        "postgres",
        "REVOKE",
        "a",
        "",
        "db",
        "public",
        "*",
        "DELETE",
      ),
    ).toBe('REVOKE DELETE ON ALL TABLES IN SCHEMA "public" FROM "a";');
    expect(() =>
      privilegeSql(
        "mysql",
        "GRANT",
        "a",
        "",
        "db",
        "",
        "*",
        "SELECT; DROP USER a",
      ),
    ).toThrow();
    expect(roleSql("postgres", "grant", "readonly", "alice", "")).toBe(
      'GRANT "readonly" TO "alice";',
    );
    expect(grantsSql("postgres", "o'brien", "")).toContain("'o''brien'");
  });
});
describe("visual query builder", () => {
  it("generates quoted aliases, validated joins, order and limits", () => {
    const sql = builderSql(
      "mysql",
      {
        tables: [a, b],
        joins: [
          { table: b, left: "0:customer_id", right: "1:id", kind: "LEFT" },
        ],
        selected: ["0:id", "1:name"],
        sort: "1:name",
        descending: true,
        limit: 100,
      },
      columns,
    );
    expect(sql).toContain(
      "LEFT JOIN `shop`.`customers` t2 ON t1.`customer_id` = t2.`id`",
    );
    expect(sql).toContain("t2.`name` AS `t2_name`");
    expect(sql).toContain("ORDER BY t2.`name` DESC\nLIMIT 100;");
  });
  it("rejects stale/missing joins, foreign columns and invalid limits", () => {
    const base = { tables: [a, b], joins: [], selected: [], limit: 100 };
    expect(() => builderSql("mysql", base, columns)).toThrow("join");
    expect(() =>
      builderSql(
        "mysql",
        { ...base, tables: [a], selected: ["4:missing"] },
        columns,
      ),
    ).toThrow("column");
    expect(() =>
      builderSql("mysql", { ...base, tables: [a], limit: NaN }, columns),
    ).toThrow("Limit");
  });
});
