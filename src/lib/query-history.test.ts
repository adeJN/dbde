import { describe, expect, it } from "vitest";
import {
  MAX_HISTORY_SQL_BYTES,
  capHistory,
  filterHistory,
  formatDuration,
  historyEnabled,
  historyEntry,
  historySummary,
  isCancelledError,
  mergeHistory,
  readHistory,
  redactSecrets,
  truncateUtf8,
  type HistoryEntry,
} from "./query-history";

const base = {
  at: 1_000,
  profileId: "p1",
  connectionName: "Local",
  database: "app",
  durationMs: 12.4,
};
function entry(patch: Partial<HistoryEntry>): HistoryEntry {
  return {
    id: crypto.randomUUID(),
    at: 1,
    profile_id: "p1",
    connection_name: "Local",
    database: "app",
    sql: "SELECT 1",
    truncated: false,
    duration_ms: 1,
    status: "success",
    ...patch,
  };
}

describe("recording", () => {
  it("summarises result sets, affected rows, errors and cancellations", () => {
    const rows = historyEntry({
      ...base,
      sql: "SELECT * FROM t",
      result: { columns: ["id"], rows: [[1], [2]], affected_rows: 0 },
    });
    expect(rows).toMatchObject({
      status: "success",
      rows: 2,
      duration_ms: 12,
      profile_id: "p1",
      connection_name: "Local",
      database: "app",
      truncated: false,
    });
    expect(historySummary(rows)).toBe("2 rows");
    const update = historyEntry({
      ...base,
      sql: "UPDATE t SET a = 1",
      result: { columns: [], rows: [], affected_rows: 7 },
    });
    expect(update.affected).toBe(7);
    expect(historySummary(update)).toBe("7 affected");
    const failed = historyEntry({
      ...base,
      sql: "SELEC",
      error: `Error: syntax error ${"x".repeat(1000)}`,
    });
    expect(failed.status).toBe("error");
    expect(failed.error!.length).toBeLessThanOrEqual(300);
    expect(failed.error!.startsWith("syntax error")).toBe(true);
    expect(
      historyEntry({
        ...base,
        sql: "SELECT pg_sleep(9)",
        error: "boom",
        cancelled: true,
      }).status,
    ).toBe("cancelled");
    expect(
      historyEntry({
        ...base,
        sql: "SELECT 1",
        error: "canceling statement due to user request",
      }).status,
    ).toBe("cancelled");
  });

  it("caps stored SQL at 64 KB on a character boundary and flags truncation", () => {
    const sql = "é".repeat(MAX_HISTORY_SQL_BYTES);
    const recorded = historyEntry({ ...base, sql });
    expect(recorded.truncated).toBe(true);
    expect(new TextEncoder().encode(recorded.sql).length).toBeLessThanOrEqual(
      MAX_HISTORY_SQL_BYTES,
    );
    expect(recorded.sql).not.toContain("�");
    expect(truncateUtf8("abc", 10)).toEqual({ text: "abc", truncated: false });
    expect(truncateUtf8("aé", 2)).toEqual({ text: "a", truncated: true });
  });

  it("masks passwords in user management statements", () => {
    expect(redactSecrets("CREATE USER 'a'@'%' IDENTIFIED BY 'hunter2';")).toBe(
      "CREATE USER 'a'@'%' IDENTIFIED BY '***';",
    );
    expect(
      redactSecrets(
        "ALTER USER a IDENTIFIED WITH mysql_native_password BY 'x''y'",
      ),
    ).toBe("ALTER USER a IDENTIFIED WITH mysql_native_password BY '***'");
    expect(redactSecrets("ALTER ROLE app WITH PASSWORD 'secret'")).toBe(
      "ALTER ROLE app WITH PASSWORD '***'",
    );
    expect(redactSecrets("SELECT password FROM users")).toBe(
      "SELECT password FROM users",
    );
    expect(historyEntry({ ...base, sql: "SET PASSWORD = 'pw'" }).sql).toBe(
      "SET PASSWORD = '***'",
    );
  });

  it("detects server cancel and timeout messages", () => {
    expect(isCancelledError("Query execution was interrupted")).toBe(true);
    expect(
      isCancelledError("Query timed out after 30 seconds and was cancelled"),
    ).toBe(true);
    expect(isCancelledError("relation does not exist")).toBe(false);
  });
});

describe("storage", () => {
  it("reads only valid unique entries", () => {
    const good = entry({ id: "a" });
    expect(
      readHistory([
        good,
        { ...good },
        { id: "b" },
        null,
        { ...good, id: "c", status: "x" },
      ]),
    ).toEqual([good]);
    expect(readHistory("nope")).toEqual([]);
  });

  it("keeps the newest entries within the entry and byte caps", () => {
    const list = Array.from({ length: 10 }, (_, i) =>
      entry({ id: String(i), at: i }),
    );
    expect(capHistory(list, 3).map((e) => e.id)).toEqual(["7", "8", "9"]);
    const size = JSON.stringify(list[0]).length + 1;
    expect(capHistory(list, 100, 2 + size * 2).map((e) => e.id)).toEqual([
      "8",
      "9",
    ]);
    const merged = mergeHistory(list, list[0]);
    expect(merged).toBe(list);
    expect(mergeHistory(list, entry({ id: "new" }))).toHaveLength(11);
  });

  it("is on unless turned off, even without storage", () => {
    expect(historyEnabled(undefined)).toBe(true);
    expect(historyEnabled({ getItem: () => "false" })).toBe(false);
    expect(
      historyEnabled({
        getItem: () => {
          throw new Error("denied");
        },
      }),
    ).toBe(true);
  });
});

describe("search and filter", () => {
  const list = [
    entry({ id: "1", at: 1, sql: "SELECT * FROM orders" }),
    entry({
      id: "2",
      at: 3,
      sql: "DELETE FROM orders",
      status: "error",
      error: "denied",
    }),
    entry({
      id: "3",
      at: 2,
      sql: "SELECT 1",
      profile_id: "p2",
      connection_name: "Prod",
      database: "shop",
    }),
  ];
  it("returns newest first and matches every word", () => {
    expect(filterHistory(list, {}).map((e) => e.id)).toEqual(["2", "3", "1"]);
    expect(
      filterHistory(list, { text: "orders select" }).map((e) => e.id),
    ).toEqual(["1"]);
    expect(filterHistory(list, { text: "DENIED" }).map((e) => e.id)).toEqual([
      "2",
    ]);
    expect(filterHistory(list, { text: "prod" }).map((e) => e.id)).toEqual([
      "3",
    ]);
  });
  it("filters by connection, database and status", () => {
    expect(filterHistory(list, { profileId: "p2" }).map((e) => e.id)).toEqual([
      "3",
    ]);
    expect(filterHistory(list, { database: "app" }).map((e) => e.id)).toEqual([
      "2",
      "1",
    ]);
    expect(filterHistory(list, { status: "error" }).map((e) => e.id)).toEqual([
      "2",
    ]);
  });
  it("formats durations", () => {
    expect(formatDuration(5)).toBe("5 ms");
    expect(formatDuration(1234)).toBe("1.23 s");
    expect(formatDuration(125_000)).toBe("2 min 5 s");
  });
});

it("redacts PostgreSQL escape and dollar-quoted passwords, including multiline secrets", () => {
  expect(
    redactSecrets(
      "CREATE ROLE app LOGIN PASSWORD $dbde_password$pa'ss\nsecret$dbde_password$;",
    ),
  ).toBe("CREATE ROLE app LOGIN PASSWORD '***';");
  expect(redactSecrets("ALTER USER app PASSWORD E'pa\\'ss';")).toBe(
    "ALTER USER app PASSWORD '***';",
  );
});
