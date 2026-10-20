import { describe, expect, it } from "vitest";
import type { ExplainOutput } from "../types";
import {
  explainSql,
  explainTarget,
  flattenPlan,
  isReadOnlyStatement,
  JsonObject,
  parseJsonKeepingDuplicates,
  parsePlan,
  splitStatements,
  type PlanNode,
} from "./explain";
// Captured from PostgreSQL 14.18, MariaDB 10.4.28 and SQLite 3.51 (see explain-samples).
import pgPlain from "./explain-samples/pg-plain.json?raw";
import pgAnalyze from "./explain-samples/pg-analyze.json?raw";
import pgUpdate from "./explain-samples/pg-update-analyze.json?raw";
import mariaJson from "./explain-samples/mariadb-json.json?raw";
import mariaAnalyze from "./explain-samples/mariadb-analyze.json?raw";
import mariaUpdate from "./explain-samples/mariadb-update-json.json?raw";
import mariaTable from "./explain-samples/mariadb-table.tsv?raw";
import sqlitePlan from "./explain-samples/sqlite-eqp.json";
import sqliteCompound from "./explain-samples/sqlite-eqp-compound.json";
// MySQL 8 is not available locally; these follow the MySQL 8.0 reference manual formats.
import mysql8Json from "./explain-samples/mysql8-json.json?raw";
import mysql8Tree from "./explain-samples/mysql8-analyze.txt?raw";
import mysql8Table from "./explain-samples/mysql8-table.json";

const output = (patch: Partial<ExplainOutput>): ExplainOutput => ({
  format: "json",
  sql: "EXPLAIN …",
  raw: "",
  columns: [],
  rows: [],
  analyzed: false,
  rolled_back: false,
  server_version: "",
  execution_ms: 1,
  ...patch,
});
const nodes = (roots: PlanNode[]) => flattenPlan(roots).map((x) => x.node);
const find = (roots: PlanNode[], test: (node: PlanNode) => boolean) =>
  nodes(roots).find(test)!;
function tsv(text: string) {
  const [header, ...lines] = text.trimEnd().split("\n");
  const parse = (value: string) =>
    value === "NULL" ? null : /^\d+$/.test(value) ? Number(value) : value;
  return {
    columns: header.split("\t"),
    rows: lines.map((line) => line.split("\t").map(parse)),
  };
}

describe("statement selection", () => {
  const sql =
    "SELECT ';' AS a FROM t;\n-- note; here\nUPDATE t SET x = 1 WHERE id = 2;\n\n";
  it("splits on real semicolons only, drops leading comments and keeps offsets", () => {
    const parts = splitStatements(sql, "postgres");
    expect(parts.map((p) => p.text)).toEqual([
      "SELECT ';' AS a FROM t",
      "UPDATE t SET x = 1 WHERE id = 2",
    ]);
    expect(sql.slice(parts[1].start, parts[1].end)).toBe(parts[1].text);
  });
  it("uses the statement under the cursor, or the selection", () => {
    expect(explainTarget(sql, "postgres", undefined, 3)).toEqual({
      statement: "SELECT ';' AS a FROM t",
    });
    expect(
      explainTarget(sql, "postgres", undefined, sql.indexOf("SET")),
    ).toEqual({
      statement: "UPDATE t SET x = 1 WHERE id = 2",
    });
    // Trailing blank lines belong to the last statement.
    expect(explainTarget(sql, "postgres", undefined, sql.length)).toEqual({
      statement: "UPDATE t SET x = 1 WHERE id = 2",
    });
    expect(
      explainTarget(sql, "postgres", { start: 0, end: sql.length }),
    ).toEqual({ error: expect.stringContaining("several statements") });
    expect(explainTarget("SELECT 1; SELECT 2", "mysql")).toEqual({
      error: expect.stringContaining("several statements"),
    });
    expect(explainTarget("SELECT 1;", "mysql")).toEqual({
      statement: "SELECT 1",
    });
  });
  it("refuses statements EXPLAIN cannot take", () => {
    for (const sql of ["DROP TABLE t", "EXPLAIN SELECT 1", "CALL p()", " ;"])
      expect(explainTarget(sql, "mysql")).toHaveProperty("error");
    expect(explainTarget("MERGE INTO t USING s ON true", "postgres")).toEqual({
      statement: "MERGE INTO t USING s ON true",
    });
  });
  it("treats only plain reads as read-only", () => {
    expect(
      isReadOnlyStatement("SELECT replace(a, 'x', 'y') FROM t", "postgres"),
    ).toBe(true);
    expect(isReadOnlyStatement("SELECT 'DELETE' FROM t", "postgres")).toBe(
      true,
    );
    expect(
      isReadOnlyStatement(
        "WITH d AS (DELETE FROM t RETURNING *) SELECT * FROM d",
        "postgres",
      ),
    ).toBe(false);
    expect(isReadOnlyStatement("SELECT * INTO c FROM t", "postgres")).toBe(
      false,
    );
    expect(isReadOnlyStatement("UPDATE t SET a = 1", "postgres")).toBe(false);
    expect(explainSql("DELETE FROM t;", "postgres", true)).toBe(
      "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) DELETE FROM t",
    );
  });
});

describe("duplicate-key JSON", () => {
  it("keeps every member, unlike JSON.parse", () => {
    const value = parseJsonKeepingDuplicates(
      '{"t": {"a": 1}, "t": {"a": -2.5e1}, "s": "x\\"y", "n": [true, null]}',
    ) as JsonObject;
    expect(value.entries.map(([key]) => key)).toEqual(["t", "t", "s", "n"]);
    expect((value.entries[1][1] as JsonObject).get("a")).toBe(-25);
    expect(value.get("s")).toBe('x"y');
    expect(() => parseJsonKeepingDuplicates('{"a": 1')).toThrow(/Invalid/);
  });
});

describe("PostgreSQL plans", () => {
  it("builds the tree with costs and estimates", () => {
    const plan = parsePlan(output({ raw: pgPlain }), "postgres");
    expect(plan.metric).toBe("cost");
    expect(nodes(plan.roots).map((n) => n.operation)).toEqual([
      "Sort",
      "Aggregate",
      "Nested Loop",
      "Index Scan",
      "Index Scan",
    ]);
    const lookup = find(plan.roots, (n) => n.index === "o_c");
    expect(lookup.object).toBe("o");
    expect(lookup.estimatedRows).toBe(5);
    expect(lookup.condition).toBe("(c_id = c.id)");
    expect(plan.totalCost).toBe(184.89);
    expect(plan.warnings).toEqual([]);
    // Nested Loop's own cost (181.55 - 9.13 - 3.47) dominates.
    expect(
      nodes(plan.roots)
        .filter((n) => n.expensive)
        .map((n) => n.operation),
    ).toEqual(["Nested Loop"]);
  });
  it("reports actual rows, loops and times when analyzed", () => {
    const plan = parsePlan(
      output({ raw: pgAnalyze, analyzed: true }),
      "postgres",
    );
    expect(plan.metric).toBe("time");
    expect(plan.executionMs).toBe(0.178);
    expect(plan.planningMs).toBe(0.647);
    const inner = find(plan.roots, (n) => n.index === "o_c");
    expect(inner).toMatchObject({ actualRows: 5, loops: 49, estimatedRows: 5 });
    expect(inner.time).toBeCloseTo(0.049);
    expect(inner.details).toContainEqual([
      "Shared Hit Blocks",
      expect.any(String),
    ]);
    const shares = nodes(plan.roots).reduce((sum, n) => sum + n.share, 0);
    expect(shares).toBeCloseTo(1);
  });
  it("flags sequential scans on rolled-back writes", () => {
    const plan = parsePlan(
      output({ raw: pgUpdate, analyzed: true }),
      "postgres",
    );
    expect(plan.roots[0].operation).toBe("ModifyTable (Update)");
    expect(plan.warnings).toEqual(["Full table scan on o"]);
    expect(find(plan.roots, (n) => n.operation === "Seq Scan").expensive).toBe(
      true,
    );
  });
});

describe("MariaDB plans", () => {
  it("keeps both tables that MariaDB lists under one temporary_table", () => {
    const plan = parsePlan(output({ raw: mariaJson }), "mysql");
    const tables = nodes(plan.roots).filter((n) => n.object);
    expect(
      tables.map((n) => [n.object, n.operation, n.index, n.estimatedRows]),
    ).toEqual([
      ["c", "Full table scan", undefined, 646],
      ["o", "Index lookup", "o_c", 2],
    ]);
    expect(
      nodes(plan.roots)
        .map((n) => n.operation)
        .slice(0, 3),
    ).toEqual(["Select #1", "Filesort", "Temporary table"]);
    expect(plan.warnings).toEqual(["Full table scan on c"]);
    expect(plan.metric).toBe("rows");
    expect(tables[0].expensive).toBe(true);
  });
  it("uses r_rows, r_loops and r_total_time_ms from ANALYZE FORMAT=JSON", () => {
    const plan = parsePlan(
      output({ raw: mariaAnalyze, analyzed: true }),
      "mysql",
    );
    expect(plan.metric).toBe("time");
    const o = find(plan.roots, (n) => n.object === "o");
    expect(o).toMatchObject({
      actualRows: 5,
      loops: 159,
      estimatedRows: 2,
      time: 1.5548,
    });
    expect(o.expensive).toBe(true);
    expect(plan.executionMs).toBe(5.1434);
  });
  it("reads UPDATE plans and the tabular EXPLAIN", () => {
    const update = parsePlan(output({ raw: mariaUpdate }), "mysql");
    expect(find(update.roots, (n) => n.object === "o").operation).toBe(
      "Full index scan (update)",
    );
    const grid = tsv(mariaTable);
    const plan = parsePlan(output({ format: "table", ...grid }), "mysql");
    expect(plan.source).toBe("mysql-table");
    expect(plan.roots[0].operation).toBe("Select #1 (SIMPLE)");
    expect(plan.roots[0].children.map((n) => n.object)).toEqual(["c", "o"]);
    expect(plan.warnings).toEqual(["Full table scan on c"]);
    expect(plan.roots[0].children[0].details).toContainEqual([
      "Extra",
      "Using where; Using temporary; Using filesort",
    ]);
    expect(plan.raw.split("\n")[0]).toBe(grid.columns.join("\t"));
  });
});

describe("MySQL 8 plans", () => {
  it("walks nested_loop and per-table cost_info", () => {
    const plan = parsePlan(
      output({ raw: mysql8Json, ...mysql8Table }),
      "mysql",
    );
    expect(plan.metric).toBe("cost");
    expect(plan.totalCost).toBe(685);
    const [c, o] = nodes(plan.roots).filter((n) => n.object);
    expect(c).toMatchObject({
      operation: "Full table scan",
      estimatedRows: 1000,
    });
    expect(o.cost).toBeCloseTo(582.75);
    expect(o.expensive).toBe(true);
    expect(plan.grid?.columns).toContain("filtered");
  });
  it("parses the EXPLAIN ANALYZE tree", () => {
    const plan = parsePlan(
      output({ format: "tree", raw: mysql8Tree, analyzed: true }),
      "mysql",
    );
    expect(plan.source).toBe("mysql-tree");
    expect(plan.roots).toHaveLength(1);
    const flat = flattenPlan(plan.roots);
    expect(flat.map((x) => x.depth)).toEqual([0, 1, 2, 3, 4, 5, 4]);
    const lookup = find(plan.roots, (n) => n.index === "o_c");
    expect(lookup).toMatchObject({
      object: "o",
      loops: 49,
      actualRows: 5,
      estimatedRows: 5,
    });
    expect(lookup.time).toBeCloseTo(1.96);
    const filter = find(plan.roots, (n) => n.operation === "Filter");
    expect(filter.condition).toBe("(c.id < 50)");
    expect(plan.warnings).toEqual(["Full table scan on c"]);
    expect(find(plan.roots, (n) => n.index === "o_c").expensive).toBe(true);
  });
  it("highlights the full scan in the classic grid", () => {
    const plan = parsePlan(
      output({ format: "table", ...mysql8Table }),
      "mysql",
    );
    expect(plan.roots[0].children[0]).toMatchObject({
      object: "c",
      expensive: true,
    });
    expect(plan.roots[0].children[1].details).toContainEqual([
      "filtered",
      "100",
    ]);
  });
});

describe("SQLite plans", () => {
  it("nests rows by parent and flags scans without an index", () => {
    const plan = parsePlan(
      output({ format: "table", ...sqlitePlan }),
      "sqlite",
    );
    expect(plan.roots.map((n) => n.operation)).toEqual([
      "SCAN o",
      "SEARCH c USING INTEGER PRIMARY KEY (rowid=?)",
      "USE TEMP B-TREE FOR GROUP BY",
      "SCALAR SUBQUERY 1",
      "USE TEMP B-TREE FOR ORDER BY",
    ]);
    expect(plan.roots[3].children[0].object).toBe("orders");
    expect(plan.roots[1].index).toBe("INTEGER PRIMARY KEY");
    expect(plan.warnings).toEqual(["Full table scan on o"]);
    expect(plan.metric).toBeUndefined();
  });
  it("does not flag covering-index scans", () => {
    const plan = parsePlan(
      output({ format: "table", ...sqliteCompound }),
      "sqlite",
    );
    expect(plan.roots[0].children.map((n) => n.operation)).toEqual([
      "LEFT-MOST SUBQUERY",
      "UNION ALL",
    ]);
    const covering = find(plan.roots, (n) => n.index === "orders_customer");
    expect(covering.warnings).toEqual([]);
    expect(plan.warnings).toEqual(["Full table scan on orders"]);
  });
});
