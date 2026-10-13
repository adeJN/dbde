import { invoke, isTauri } from "@tauri-apps/api/core";
import { tableQuery, quoteIdentifier, tableFilterClause } from "./sql";
import type {
  ConnectionConfig,
  QueryResult,
  SchemaTree,
  ColumnInfo,
  TableInfo,
  TableSource,
  TableFilter,
  TableSort,
} from "../types";
export const desktop = isTauri();
export const demoConfig: ConnectionConfig = {
  id: "demo",
  name: "Sandbox",
  driver: "sqlite",
  host: "",
  port: 0,
  username: "",
  database: "workspace",
  ssl_mode: "disable",
  file_path: ":memory:",
};
let demo: Promise<import("sql.js").Database> | undefined;
async function demoDb() {
  if (!demo)
    demo = (async () => {
      const [{ default: init }, { default: wasm }] = await Promise.all([
        import("sql.js"),
        import("sql.js/dist/sql-wasm.wasm?url"),
      ]);
      const SQL = await init({ locateFile: () => wasm });
      const db = new SQL.Database();
      db.run(
        "CREATE TABLE customers (id INTEGER PRIMARY KEY, name TEXT NOT NULL, email TEXT, plan TEXT, status TEXT, created_at TEXT); CREATE TABLE orders (id INTEGER PRIMARY KEY, customer_id INTEGER, total REAL, status TEXT); CREATE TABLE products (id INTEGER PRIMARY KEY, name TEXT, price REAL);",
      );
      const stmt = db.prepare(
        "INSERT INTO customers VALUES (?, ?, ?, ?, ?, ?)",
      );
      const names = [
        "Olivia Rhye",
        "Phoenix Baker",
        "Lana Steiner",
        "Demi Wilkinson",
        "Drew Cano",
        "Natali Craig",
        "Orlando Diggs",
        "Andi Lane",
      ];
      for (let i = 1; i <= 240; i++)
        stmt.run([
          i,
          names[(i - 1) % names.length],
          `${names[(i - 1) % names.length].toLowerCase().replace(" ", ".")}+${i}@example.com`,
          ["Pro", "Team", "Free"][i % 3],
          i % 7 ? "active" : "inactive",
          `2026-10-${String(1 + (i % 13)).padStart(2, "0")}`,
        ]);
      stmt.free();
      db.run(
        "INSERT INTO orders VALUES (1, 1, 149.00, 'completed'), (2, 2, 79.00, 'pending'); INSERT INTO products VALUES (1, 'Workspace Pro', 29), (2, 'Workspace Team', 79)",
      );
      return db;
    })();
  return demo;
}
export async function execute(
  connectionId: string,
  query: string,
  database?: string,
  sessionId?: string,
): Promise<QueryResult> {
  if (desktop)
    return invoke("dbde_execute_query", {
      connectionId,
      query,
      database,
      ...(sessionId ? { sessionId } : {}),
    });
  const db = await demoDb();
  const start = performance.now();
  let resultColumns: string[] = [];
  let rows: unknown[][] = [];
  let affected = 0;
  let truncated = false;
  for (const statement of db.iterateStatements(query)) {
    try {
      resultColumns = statement.getColumnNames();
      rows = [];
      truncated = false;
      while (statement.step()) {
        if (rows.length === 50000) {
          truncated = true;
          break;
        }
        rows.push(statement.get());
      }
      if (!resultColumns.length) affected += db.getRowsModified();
    } finally {
      statement.free();
    }
  }
  return {
    columns: resultColumns,
    rows,
    affected_rows: affected,
    execution_ms: Math.round((performance.now() - start) * 100) / 100,
    truncated,
  };
}
export async function listDatabases(connectionId: string): Promise<string[]> {
  return desktop
    ? invoke("dbde_list_databases", { connectionId })
    : ["workspace"];
}
export async function schema(
  connectionId: string,
  database?: string,
): Promise<SchemaTree> {
  if (desktop)
    return invoke("dbde_get_schema_tree", { connectionId, database });
  const db = await demoDb();
  const result = db.exec(
    "SELECT name, type FROM sqlite_master WHERE type IN ('table', 'view') AND name NOT LIKE 'sqlite_%' ORDER BY name",
  );
  return {
    database: "workspace",
    tables: (result[0]?.values ?? []).map((r) => ({
      name: String(r[0]),
      schema: "",
      kind: String(r[1]),
    })),
  };
}
export async function columns(
  connectionId: string,
  table: TableInfo,
  database?: string,
): Promise<ColumnInfo[]> {
  if (desktop)
    return invoke("dbde_get_columns", { connectionId, table, database });
  const db = await demoDb();
  const result = db.exec(
    `PRAGMA table_info("${table.name.replaceAll('"', '""')}")`,
  );
  return (result[0]?.values ?? []).map((r) => ({
    name: String(r[1]),
    data_type: String(r[2]),
    nullable: !r[3],
  }));
}
export const listProfiles = (): Promise<ConnectionConfig[]> =>
  desktop ? invoke("dbde_list_profiles") : Promise.resolve([]);
export async function viewTable(
  connectionId: string,
  database: string,
  table: TableInfo,
  page = 1,
  pageSize = 1000,
  filters: TableFilter[] = [],
  sort?: TableSort,
): Promise<QueryResult> {
  tableQuery(table, "sqlite", pageSize, page); // Validate pagination before IPC or SQL construction.
  if (desktop)
    return invoke("dbde_view_table", {
      connectionId,
      database,
      table,
      page,
      pageSize,
      ...(filters.length ? { filters } : {}),
      ...(sort ? { sort } : {}),
    });
  const db = await demoDb();
  const statement = db.prepare(
    "SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk",
  );
  const primary_keys: string[] = [];
  try {
    statement.bind([table.name]);
    while (statement.step()) primary_keys.push(String(statement.get()[0]));
  } finally {
    statement.free();
  }
  const target = `${table.schema ? quoteIdentifier(table.schema, "sqlite") + "." : ""}${quoteIdentifier(table.name, "sqlite")}`;
  const names =
    db
      .exec(
        `SELECT name FROM pragma_table_info('${table.name.replaceAll("'", "''")}')`,
      )[0]
      ?.values.map((row) => String(row[0])) ?? [];
  if (filters.some((filter) => !names.includes(filter.column)))
    throw new Error("Unknown filter column.");
  if (
    sort &&
    (!names.includes(sort.column) || !["asc", "desc"].includes(sort.direction))
  )
    throw new Error("Unknown sort column or direction.");
  const clause = tableFilterClause(filters, "sqlite");
  const countStatement = db.prepare(
    `SELECT COUNT(*) FROM ${target}${clause.sql}`,
  );
  let totalRows = 0;
  try {
    countStatement.bind(clause.values);
    if (countStatement.step()) totalRows = Number(countStatement.get()[0]);
  } finally {
    countStatement.free();
  }
  const actualPage = Math.min(
    page,
    Math.max(1, Math.ceil(totalRows / pageSize)),
  );
  const result = await execute(
    connectionId,
    tableQuery(
      table,
      "sqlite",
      pageSize,
      actualPage,
      primary_keys,
      filters,
      sort,
    ),
    database,
  );
  return {
    ...result,
    source: {
      table,
      database,
      primary_keys,
      ...(filters.length ? { filters } : {}),
      ...(sort ? { sort } : {}),
    },
    pagination: {
      page: actualPage,
      page_size: pageSize,
      total_rows: totalRows,
    },
  };
}
export async function deleteRows(
  connectionId: string,
  source: TableSource,
  keys: Record<string, unknown>[],
): Promise<number> {
  if (desktop)
    return invoke("dbde_delete_rows", {
      connectionId,
      database: source.database,
      table: source.table,
      keys,
    });
  if (!keys.length || keys.length > 1000)
    throw new Error("Select between 1 and 1,000 rows to delete.");
  const db = await demoDb();
  const metadata = await viewTable(connectionId, source.database, source.table);
  const primaryKeys = metadata.source!.primary_keys;
  if (!primaryKeys.length) throw new Error("This table has no primary key.");
  const seen = new Set<string>();
  const values = keys.map((key) => {
    if (
      Object.keys(key).length !== primaryKeys.length ||
      primaryKeys.some((column) => !(column in key))
    )
      throw new Error("The complete primary key is required.");
    const row = primaryKeys.map((column) => {
      const value = key[column];
      if (
        value == null ||
        typeof value === "object" ||
        (typeof value === "number" && !Number.isSafeInteger(value))
      )
        throw new Error("Unsupported primary key value.");
      return String(value);
    });
    const identity = JSON.stringify(row);
    if (seen.has(identity))
      throw new Error("Duplicate primary keys in selection.");
    seen.add(identity);
    return row;
  });
  const sql = `DELETE FROM ${quoteIdentifier(source.table.name, "sqlite")} WHERE ${primaryKeys.map((column) => `CAST(${quoteIdentifier(column, "sqlite")} AS TEXT) COLLATE BINARY = ?`).join(" AND ")}`;
  db.run("BEGIN");
  try {
    for (const row of values) {
      db.run(sql, row);
      if (db.getRowsModified() !== 1)
        throw new Error(
          "The selection is stale. No rows were deleted. Refresh the table.",
        );
    }
    db.run("COMMIT");
    return keys.length;
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}
export async function updateCell(
  connectionId: string,
  source: TableSource,
  key: Record<string, unknown>,
  column: string,
  value: string | null,
): Promise<number> {
  if (desktop)
    return invoke("dbde_update_cell", {
      connectionId,
      database: source.database,
      table: source.table,
      key,
      column,
      value,
    });
  if (source.table.kind !== "table")
    throw new Error("Records can only be changed in a table.");
  const db = await demoDb();
  const names = (
    await columns(connectionId, source.table, source.database)
  ).map((item) => item.name);
  if (!names.includes(column) || source.primary_keys.includes(column))
    throw new Error("This column cannot be edited.");
  if (value !== null && new TextEncoder().encode(value).length > 1_000_000)
    throw new Error("Cell value exceeds 1 MB.");
  const keys = source.primary_keys;
  if (
    !keys.length ||
    Object.keys(key).length !== keys.length ||
    keys.some((name) => key[name] == null)
  )
    throw new Error("The complete primary key is required.");
  const sql = `UPDATE ${quoteIdentifier(source.table.name, "sqlite")} SET ${quoteIdentifier(column, "sqlite")} = ? WHERE ${keys.map((name) => `CAST(${quoteIdentifier(name, "sqlite")} AS TEXT) COLLATE BINARY = ?`).join(" AND ")}`;
  db.run(sql, [value, ...keys.map((name) => String(key[name]))]);
  const changed = db.getRowsModified();
  if (changed !== 1)
    throw new Error(
      "The record was not updated. Refresh the table and try again.",
    );
  return changed;
}
export async function insertRecord(
  connectionId: string,
  source: TableSource,
  values: Record<string, string | null>,
): Promise<number> {
  if (desktop)
    return invoke("dbde_insert_record", {
      connectionId,
      database: source.database,
      table: source.table,
      values,
    });
  if (source.table.kind !== "table")
    throw new Error("Records can only be changed in a table.");
  const db = await demoDb();
  const names = (
    await columns(connectionId, source.table, source.database)
  ).map((item) => item.name);
  const selected = names.filter((name) => Object.hasOwn(values, name));
  if (Object.keys(values).some((name) => !names.includes(name)))
    throw new Error("Unknown insert column.");
  if (
    selected.some(
      (name) =>
        values[name] !== null &&
        new TextEncoder().encode(values[name]).length > 1_000_000,
    )
  )
    throw new Error("Cell value exceeds 1 MB.");
  const target = quoteIdentifier(source.table.name, "sqlite");
  const sql = selected.length
    ? `INSERT INTO ${target} (${selected.map((name) => quoteIdentifier(name, "sqlite")).join(", ")}) VALUES (${selected.map(() => "?").join(", ")})`
    : `INSERT INTO ${target} DEFAULT VALUES`;
  db.run(
    sql,
    selected.map((name) => values[name]),
  );
  const inserted = db.getRowsModified();
  if (inserted !== 1) throw new Error("The record was not inserted.");
  return inserted;
}
export const saveProfile = (config: ConnectionConfig): Promise<void> =>
  invoke("dbde_save_profile", { config });
export const deleteProfile = (id: string): Promise<void> =>
  invoke("dbde_delete_profile", { id });
export const testConnection = (config: ConnectionConfig): Promise<boolean> =>
  invoke("dbde_test_connection", { config });
export const connect = (config: ConnectionConfig): Promise<string> =>
  invoke("dbde_connect", { config });
export const closeSession = (
  connectionId: string,
  sessionId: string,
): Promise<void> =>
  desktop
    ? invoke("dbde_close_session", { connectionId, sessionId })
    : Promise.resolve();
export const disconnect = (connectionId: string): Promise<void> =>
  desktop ? invoke("dbde_disconnect", { connectionId }) : Promise.resolve();
