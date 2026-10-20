import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { useWorkspace } from "../store";
import {
  connectionKey,
  withoutSecrets,
  configuredDatabases,
} from "./connections";
import {
  tableQuery,
  quoteIdentifier,
  tableFilterClause,
  tableActionSql,
  renameTableSql,
  tableNameError,
} from "./sql";
import type {
  ConnectionConfig,
  QueryResult,
  SchemaTree,
  ColumnInfo,
  ForeignKeyInfo,
  IndexInfo,
  TableInfo,
  TableSource,
  TableFilter,
  TableSort,
  RecordChange,
  QueryTab,
  Session,
  ForeignKeyChecks,
  ExplainOutput,
  DbObject,
  ObjectDefinition,
  ObjectKind,
  ObjectStatementAction,
} from "../types";
import { objectKinds, sqliteTriggerTiming } from "./db-objects";
import { explainSql, explainStatementError } from "./explain";
import {
  maintainInfo,
  maintainSql,
  type MaintainOperation,
  type MaintainResult,
  type MaintainRow,
} from "./maintain";
import { validateChanges } from "./value-validation";
import { buildTablePlan, type TableDesign } from "./table-designer";
import { fieldRenameError, type FieldRename } from "./field-renames";
import type { FieldChange } from "./field-changes";
import {
  EXPORT_FORMATS,
  MAX_FETCHED_EXPORT_ROWS,
  exportText,
  type ExportOptions,
  type ExportSummary,
} from "./export";
import {
  MAX_ERRORS,
  MAX_IMPORT_ROWS,
  defaultParseOptions,
  mappingError,
  parseImportText,
  parseOptionsError,
  type ImportFormat,
  type ImportParseOptions,
  type ImportPreview,
  type ImportRequest,
  type ImportSummary,
  type ImportTarget,
} from "./import";
import {
  MAX_HISTORY_ENTRIES,
  SANDBOX_HISTORY_BYTES,
  capHistory,
  readHistory,
  type HistoryEntry,
} from "./query-history";
export const desktop = isTauri();
export async function closeDetachedWindow(): Promise<void> {
  await invoke("dbde_close_detached_window");
}
export async function guardDetachedWindowClose(
  approve: () => Promise<boolean>,
): Promise<() => void> {
  const { getCurrentWindow } = await import("@tauri-apps/api/window");
  let checking = false;
  return getCurrentWindow().onCloseRequested(async (event) => {
    event.preventDefault();
    if (checking) return;
    checking = true;
    try {
      if (await approve()) await invoke("dbde_close_detached_window");
    } finally {
      checking = false;
    }
  });
}
export async function moveTabToWindow(
  session: Session,
  tab: QueryTab,
): Promise<void> {
  if (tab.kind === "database")
    throw new Error("Database tabs cannot be moved to a new window.");
  if (!desktop)
    throw new Error("Moving tabs to new windows requires the desktop app.");
  const config = withoutSecrets(session.config);
  await invoke("dbde_move_tab_to_window", {
    connectionId: session.id,
    snapshot: {
      session: { ...session, config },
      tab: { ...tab, running: false },
    },
  });
}
export async function loadDetachedWorkspace(): Promise<void> {
  if (!desktop || location.hash !== "#detached") return;
  const snapshot = await invoke<{ session: Session; tab: QueryTab }>(
    "dbde_get_detached_workspace",
  );
  useWorkspace.setState({
    singleTab: true,
    sessions: [snapshot.session],
    tabs: [snapshot.tab],
    activeTab: snapshot.tab.id,
  });
}
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
  timeoutSecs?: number,
): Promise<QueryResult> {
  if (desktop)
    return invoke("dbde_execute_query", {
      connectionId,
      query,
      database,
      ...(sessionId ? { sessionId } : {}),
      ...(timeoutSecs ? { timeoutSecs } : {}),
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
/**
 * The query plan of one statement. EXPLAIN never runs it; with `analyze` it does run, and
 * PostgreSQL writes need `allowWrite` and are rolled back. Uses the tab's own session so
 * temporary tables, search_path and session settings apply.
 */
export async function explain(
  connectionId: string,
  statement: string,
  database: string | undefined,
  sessionId: string | undefined,
  analyze: boolean,
  allowWrite: boolean,
  timeoutSecs?: number,
): Promise<ExplainOutput> {
  if (desktop)
    return invoke("dbde_explain_query", {
      connectionId,
      query: statement,
      database,
      ...(sessionId ? { sessionId } : {}),
      analyze,
      allowWrite,
      ...(timeoutSecs ? { timeoutSecs } : {}),
    });
  if (analyze)
    throw new Error(
      "SQLite has no EXPLAIN ANALYZE; showing the query plan needs no option.",
    );
  const error = explainStatementError(statement, "sqlite");
  if (error) throw new Error(error);
  const db = await demoDb();
  const sql = explainSql(statement, "sqlite", false);
  const start = performance.now();
  const [result] = db.exec(sql);
  return {
    format: "table",
    sql,
    raw: "",
    columns: result?.columns ?? ["id", "parent", "notused", "detail"],
    rows: result?.values ?? [],
    analyzed: false,
    rolled_back: false,
    server_version: "",
    execution_ms: Math.round((performance.now() - start) * 100) / 100,
  };
}
/** Runs a maintenance operation (ANALYZE, CHECK, VACUUM…) on the given tables. */
export async function maintainTables(
  connectionId: string,
  database: string,
  tables: TableInfo[],
  operation: MaintainOperation,
  timeoutSecs?: number,
): Promise<MaintainResult> {
  if (desktop)
    return invoke("dbde_maintain_tables", {
      connectionId,
      database,
      tables,
      operation,
      ...(timeoutSecs ? { timeoutSecs } : {}),
    });
  const statements = maintainSql(operation, "sqlite", tables);
  const info = maintainInfo(operation, "sqlite")!;
  const names = info.databaseWide
    ? [database]
    : tables.map((table) => table.name);
  const db = await demoDb();
  const start = performance.now();
  const rows: MaintainRow[] = [];
  const op = info.label.toLowerCase();
  statements.forEach((sql, index) => {
    const table = names[index];
    try {
      const values = db.exec(sql)[0]?.values ?? [];
      if (!values.length)
        rows.push({ table, op, msg_type: "status", msg_text: "OK" });
      for (const [message] of values)
        rows.push({
          table,
          op,
          msg_type: message === "ok" ? "status" : "error",
          msg_text: message === "ok" ? "OK" : String(message),
        });
    } catch (cause) {
      rows.push({ table, op, msg_type: "error", msg_text: String(cause) });
    }
  });
  return {
    statements,
    rows,
    execution_ms: Math.round((performance.now() - start) * 100) / 100,
  };
}
export async function listDatabases(connectionId: string): Promise<string[]> {
  const config = useWorkspace
    .getState()
    .sessions.find((session) => session.id === connectionId)?.config;
  const configured = configuredDatabases(config);
  if (configured) return configured;
  return desktop
    ? invoke("dbde_list_databases", { connectionId })
    : ["workspace"];
}
export async function discoverDatabases(
  config: ConnectionConfig,
): Promise<string[]> {
  if (!desktop) throw new Error("Database discovery requires the desktop app.");
  return invoke("dbde_discover_databases", { config });
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
    ...(/^\s*bool(ean)?\s*$/i.test(String(r[2])) ? { is_boolean: true } : {}),
  }));
}
/** Foreign keys of a table, with their column pairs in key order. */
export async function foreignKeys(
  connectionId: string,
  table: TableInfo,
  database?: string,
): Promise<ForeignKeyInfo[]> {
  if (desktop)
    return invoke("dbde_get_foreign_keys", { connectionId, table, database });
  // The sandbox table was read from the in-memory database, so it is open by now;
  // never start the engine just to list keys.
  if (!demo) return [];
  const db = await demoDb();
  const read = (sql: string, params: string[]) => {
    const statement = db.prepare(sql);
    const rows: unknown[][] = [];
    try {
      statement.bind(params);
      while (statement.step()) rows.push(statement.get());
    } finally {
      statement.free();
    }
    return rows;
  };
  const keys = new Map<number, ForeignKeyInfo & { targets: unknown[] }>();
  for (const [id, parent, from, to] of read(
    'SELECT id, "table", "from", "to" FROM pragma_foreign_key_list(?) ORDER BY id, seq',
    [table.name],
  )) {
    const key = keys.get(Number(id)) ?? {
      name: `fk_${id}`,
      columns: [],
      referenced_table: { name: String(parent), schema: "", kind: "table" },
      referenced_columns: [],
      targets: [],
    };
    key.columns.push(String(from));
    key.targets.push(to);
    keys.set(Number(id), key);
  }
  return [...keys.values()].map(({ targets, ...key }) => {
    // `REFERENCES parent` without columns means the parent's primary key.
    const implicit = targets.some((target) => target == null)
      ? read("SELECT name FROM pragma_table_info(?) WHERE pk > 0 ORDER BY pk", [
          key.referenced_table.name,
        ]).map((row) => String(row[0]))
      : [];
    return {
      ...key,
      referenced_columns: targets.map((target, index) =>
        target == null ? (implicit[index] ?? "") : String(target),
      ),
    };
  });
}
export async function renameTableFields(
  connectionId: string,
  database: string,
  table: TableInfo,
  renames: FieldRename[],
): Promise<void> {
  if (table.kind !== "table")
    throw new Error("Rename fields is available for tables only.");
  if (desktop)
    return invoke("dbde_rename_table_fields", {
      connectionId,
      database,
      table,
      renames,
    });
  const db = await demoDb();
  const statement = db.prepare("SELECT name FROM pragma_table_xinfo(?)");
  const names: string[] = [];
  try {
    statement.bind([table.name]);
    while (statement.step()) names.push(String(statement.get()[0]));
  } finally {
    statement.free();
  }
  const error = fieldRenameError(names, renames, "sqlite");
  if (error || !renames.length)
    throw new Error(error || "No field renames to save.");
  db.run("BEGIN");
  try {
    for (const rename of renames)
      db.run(
        `ALTER TABLE ${quoteIdentifier(table.name, "sqlite")} RENAME COLUMN ${quoteIdentifier(rename.from, "sqlite")} TO ${quoteIdentifier(rename.to, "sqlite")}`,
      );
    db.run("COMMIT");
  } catch (cause) {
    db.run("ROLLBACK");
    throw cause;
  }
}
export async function alterTableFields(
  connectionId: string,
  database: string,
  table: TableInfo,
  changes: FieldChange[],
  preview = false,
): Promise<string> {
  if (!desktop)
    throw new Error(
      "Field property editing is available in the desktop MySQL/MariaDB designer. Use SQL Editor for SQLite field definitions.",
    );
  return invoke("dbde_alter_table_fields", {
    connectionId,
    database,
    table,
    changes,
    preview,
  });
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
  quick = false,
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
      ...(quick ? { quick } : {}),
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
        `SELECT name FROM pragma_table_xinfo('${table.name.replaceAll("'", "''")}')`,
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
  if (quick && !primary_keys.length)
    throw new Error(
      "Quick mode requires a primary key. Use Open Table instead.",
    );
  const deferred = quick
    ? (await columns(connectionId, table, database))
        .filter((c) => /blob/i.test(c.data_type))
        .map((c) => c.name)
    : [];
  if (quick && primary_keys.some((key) => deferred.includes(key)))
    throw new Error(
      "Quick mode requires scalar primary keys. Use Open Table instead.",
    );
  const projection = quick
    ? names
        .map(
          (name) =>
            `${deferred.includes(name) ? "NULL AS " : ""}${quoteIdentifier(name, "sqlite")}`,
        )
        .join(", ")
    : "*";
  const sql = tableQuery(
    table,
    "sqlite",
    pageSize,
    actualPage,
    primary_keys,
    filters,
    sort,
  ).replace("SELECT *", `SELECT ${projection}`);
  const result = await execute(connectionId, sql, database);
  for (const row of result.rows)
    for (const name of deferred)
      row[result.columns.indexOf(name)] = { deferred: true };
  return {
    ...result,
    source: {
      ...(quick ? { quick } : {}),
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
/** Fetch fresh metadata before writes; never infer types from displayed values. */
async function validateRecordChanges(
  connectionId: string,
  source: TableSource,
  changes: RecordChange[],
) {
  const keys = source.primary_keys;
  const changesKey = changes.some(
    (change) =>
      change.kind === "update" &&
      keys.some((name) => Object.hasOwn(change.values, name)),
  );
  if (changesKey) {
    const seen = new Set<string>();
    for (const change of changes) {
      if (change.kind === "insert") continue;
      const id = JSON.stringify(keys.map((name) => String(change.key[name])));
      if (seen.has(id))
        throw new Error(
          "A primary key edit cannot target the same record more than once. Nothing was saved.",
        );
      seen.add(id);
      if (
        change.kind === "update" &&
        keys.some(
          (name) =>
            Object.hasOwn(change.values, name) && change.values[name] === null,
        )
      )
        throw new Error("Primary key values cannot be NULL.");
    }
  }
  if (!changes.some((change) => change.kind !== "delete")) return;
  const info = await columns(connectionId, source.table, source.database);
  const driver =
    useWorkspace
      .getState()
      .sessions.find((session) => session.id === connectionId)?.config.driver ??
    "sqlite";
  validateChanges(info, changes, driver);
}
export async function updateCell(
  connectionId: string,
  source: TableSource,
  key: Record<string, unknown>,
  column: string,
  value: string | null,
): Promise<number> {
  await validateRecordChanges(connectionId, source, [
    { kind: "update", key, values: { [column]: value } },
  ]);
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
  if (!names.includes(column)) throw new Error("This column cannot be edited.");
  if (source.primary_keys.includes(column))
    return applyChanges(connectionId, source, [
      { kind: "update", key, values: { [column]: value } },
    ]);
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
  if (desktop) {
    await validateRecordChanges(connectionId, source, [
      { kind: "insert", values },
    ]);
    return invoke("dbde_insert_record", {
      connectionId,
      database: source.database,
      table: source.table,
      values,
    });
  }
  return insertRecords(connectionId, source, [values]);
}
/** Inserts every record in one transaction: all are saved or none are. */
export async function insertRecords(
  connectionId: string,
  source: TableSource,
  records: Record<string, string | null>[],
): Promise<number> {
  await validateRecordChanges(
    connectionId,
    source,
    records.map((values) => ({ kind: "insert", values })),
  );
  if (desktop)
    return invoke("dbde_insert_records", {
      connectionId,
      database: source.database,
      table: source.table,
      records,
    });
  if (source.table.kind !== "table")
    throw new Error("Records can only be changed in a table.");
  if (!records.length || records.length > 1000)
    throw new Error("Save between 1 and 1,000 records at a time.");
  const db = await demoDb();
  const names = (
    await columns(connectionId, source.table, source.database)
  ).map((item) => item.name);
  const target = quoteIdentifier(source.table.name, "sqlite");
  const statements = records.map((values) => {
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
    return {
      sql: selected.length
        ? `INSERT INTO ${target} (${selected.map((name) => quoteIdentifier(name, "sqlite")).join(", ")}) VALUES (${selected.map(() => "?").join(", ")})`
        : `INSERT INTO ${target} DEFAULT VALUES`,
      params: selected.map((name) => values[name]),
    };
  });
  db.run("BEGIN");
  try {
    statements.forEach(({ sql, params }, index) => {
      try {
        db.run(sql, params);
      } catch (error) {
        throw new Error(
          `Record ${index + 1} of ${statements.length}: ${String(error)}. No records were saved.`,
        );
      }
      if (db.getRowsModified() !== 1)
        throw new Error(
          `Record ${index + 1} was not inserted. No records were saved.`,
        );
    });
    db.run("COMMIT");
    return statements.length;
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}
/** Applies staged edits, inserts and deletes in one transaction: all or nothing. */
export async function applyChanges(
  connectionId: string,
  source: TableSource,
  changes: RecordChange[],
): Promise<number> {
  await validateRecordChanges(connectionId, source, changes);
  if (desktop)
    return invoke("dbde_apply_changes", {
      connectionId,
      database: source.database,
      table: source.table,
      changes,
    });
  if (source.table.kind !== "table")
    throw new Error("Records can only be changed in a table.");
  if (!changes.length || changes.length > 5000)
    throw new Error("Apply between 1 and 5,000 changes at a time.");
  const db = await demoDb();
  const names = (
    await columns(connectionId, source.table, source.database)
  ).map((item) => item.name);
  const keys = source.primary_keys;
  const target = quoteIdentifier(source.table.name, "sqlite");
  const q = (name: string) => quoteIdentifier(name, "sqlite");
  const keyParams = (key: Record<string, unknown>) => {
    if (
      !keys.length ||
      Object.keys(key).length !== keys.length ||
      keys.some((name) => key[name] == null || typeof key[name] === "object")
    )
      throw new Error("The complete primary key is required.");
    return keys.map((name) => key[name] as string | number);
  };
  const where = keys.map((name) => `${q(name)} = ?`).join(" AND ");
  // Updates to identities run last, so earlier actions still address stored keys.
  const changesKey = (change: RecordChange) =>
    change.kind === "update" &&
    keys.some((name) => Object.hasOwn(change.values, name));
  const ordered = changes
    .map((change, index) => ({ change, index }))
    .sort(
      (a, b) => Number(changesKey(a.change)) - Number(changesKey(b.change)),
    );
  const statements = ordered.map(({ change, index }) => {
    const label = `Change ${index + 1} of ${changes.length}`;
    if (change.kind === "delete")
      return {
        label,
        sql: `DELETE FROM ${target} WHERE ${where}`,
        params: keyParams(change.key),
      };
    const selected = Object.keys(change.values);
    if (selected.some((name) => !names.includes(name)))
      throw new Error(`${label}: unknown column.`);
    if (change.kind === "insert")
      return {
        label,
        sql: selected.length
          ? `INSERT INTO ${target} (${selected.map(q).join(", ")}) VALUES (${selected.map(() => "?").join(", ")})`
          : `INSERT INTO ${target} DEFAULT VALUES`,
        params: selected.map((name) => change.values[name]),
      };
    if (!selected.length)
      throw new Error(`${label}: these columns cannot be edited.`);
    return {
      label,
      sql: `UPDATE ${target} SET ${selected.map((name) => `${q(name)} = ?`).join(", ")} WHERE ${where}`,
      params: [
        ...selected.map((name) => change.values[name]),
        ...keyParams(change.key),
      ],
    };
  });
  db.run("BEGIN");
  try {
    for (const { label, sql, params } of statements) {
      try {
        db.run(sql, params);
      } catch (error) {
        throw new Error(`${label}: ${String(error)}. Nothing was saved.`);
      }
      if (db.getRowsModified() !== 1)
        throw new Error(
          `${label} matched ${db.getRowsModified()} rows instead of one. Nothing was saved. Refresh and try again.`,
        );
    }
    db.run("COMMIT");
    return statements.length;
  } catch (error) {
    db.run("ROLLBACK");
    throw error;
  }
}
export const saveProfile = (config: ConnectionConfig): Promise<void> =>
  invoke("dbde_save_profile", { config });
export const deleteProfile = (id: string): Promise<void> =>
  invoke("dbde_delete_profile", { id });
export const testConnection = (config: ConnectionConfig): Promise<boolean> =>
  invoke("dbde_test_connection", { config });
// Keep the resolved ID until disconnect: a dialog may still be saving a profile
// before it registers its session, while another entry point requests the same server.
const connections = new Map<
  string,
  { promise: Promise<string>; id?: string }
>();
export function connect(config: ConnectionConfig): Promise<string> {
  const key = connectionKey(config);
  const active = useWorkspace
    .getState()
    .sessions.find((s) => connectionKey(s.config) === key);
  if (active) return Promise.resolve(active.id);
  const existing = connections.get(key);
  if (existing) return existing.promise;
  const entry: { promise: Promise<string>; id?: string } = {
    promise: invoke<string>("dbde_connect", { config })
      .then((id) => {
        entry.id = id;
        return id;
      })
      .catch((error) => {
        if (connections.get(key) === entry) connections.delete(key);
        throw error;
      }),
  };
  connections.set(key, entry);
  return entry.promise;
}
/** Validates changed credentials without reusing an existing server pool. */
export const connectFresh = (config: ConnectionConfig): Promise<string> =>
  invoke("dbde_connect", { config });
export const cancelQuery = (
  connectionId: string,
  sessionId: string,
): Promise<boolean> =>
  desktop
    ? invoke("dbde_cancel_query", { connectionId, sessionId })
    : Promise.resolve(false);
/** Whether the tab's server session holds an uncommitted transaction. */
export const sessionInTransaction = (
  connectionId: string,
  sessionId: string,
): Promise<boolean> =>
  desktop
    ? invoke("dbde_session_in_transaction", { connectionId, sessionId })
    : Promise.resolve(false);
export async function listIndexes(
  connectionId: string,
  table: TableInfo,
  database?: string,
): Promise<IndexInfo[]> {
  if (desktop)
    return invoke("dbde_list_indexes", { connectionId, table, database });
  const db = await demoDb();
  const list = db.exec(
    `SELECT name, "unique", origin FROM pragma_index_list('${table.name.replaceAll("'", "''")}') ORDER BY origin = 'pk' DESC, name`,
  )[0];
  return (list?.values ?? []).map(([name, unique, origin]) => ({
    name: String(name),
    columns: (
      db.exec(
        `SELECT name FROM pragma_index_info('${String(name).replaceAll("'", "''")}') ORDER BY seqno`,
      )[0]?.values ?? []
    ).map(([column]) => (column == null ? "(expression)" : String(column))),
    unique: Boolean(unique),
    primary: origin === "pk",
  }));
}
/** CREATE statements for a table or view, including its indexes. */
export async function tableDdl(
  connectionId: string,
  table: TableInfo,
  database?: string,
  withoutForeignKeys = false,
): Promise<string> {
  if (desktop)
    return invoke("dbde_table_ddl", {
      connectionId,
      table,
      database,
      ...(withoutForeignKeys ? { withoutForeignKeys } : {}),
    });
  const db = await demoDb();
  const statement = db.prepare(
    "SELECT sql FROM sqlite_master WHERE tbl_name = ? AND sql IS NOT NULL ORDER BY type = 'table' DESC, type = 'view' DESC, name",
  );
  const sql: string[] = [];
  try {
    statement.bind([table.name]);
    while (statement.step()) sql.push(String(statement.get()[0]) + ";");
  } finally {
    statement.free();
  }
  if (!sql.length) throw new Error("Table not found.");
  return sql.join("\n\n");
}
/** Functions, procedures, triggers, events, sequences or materialized views of a database. */
export async function listObjects(
  connectionId: string,
  database: string | undefined,
  kind: ObjectKind,
): Promise<DbObject[]> {
  if (desktop)
    return invoke("dbde_list_objects", { connectionId, database, kind });
  if (!objectKinds("sqlite").includes(kind))
    throw new Error("SQLite has only triggers.");
  const db = await demoDb();
  const rows =
    db.exec(
      "SELECT name, tbl_name, sql FROM sqlite_master WHERE type = 'trigger' ORDER BY name",
    )[0]?.values ?? [];
  return rows.map(([name, table, sql]) => ({
    kind,
    schema: "",
    name: String(name),
    table: String(table),
    detail: sqliteTriggerTiming(String(sql ?? "")),
  }));
}
/** The object's definition, a replace script for editing and, for routines, a call template. */
export async function objectDefinition(
  connectionId: string,
  database: string | undefined,
  object: DbObject,
): Promise<ObjectDefinition> {
  if (desktop)
    return invoke("dbde_object_definition", { connectionId, database, object });
  if (object.kind !== "trigger") throw new Error("SQLite has only triggers.");
  const db = await demoDb();
  const statement = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'trigger' AND name = ?",
  );
  let sql: string | undefined;
  try {
    statement.bind([object.name]);
    if (statement.step()) sql = String(statement.get()[0] ?? "");
  } finally {
    statement.free();
  }
  if (!sql)
    throw new Error("The trigger no longer exists. Refresh and try again.");
  const definition = `${sql.trim().replace(/;$/, "")};`;
  return {
    definition,
    edit_script: `-- SQLite cannot replace a trigger in place: the DROP runs first.\nDROP TRIGGER IF EXISTS ${quoteIdentifier(object.name, "sqlite")};\n${definition}\n`,
  };
}
/**
 * Builds (`preview`) or runs one validated statement on an object and resolves to its SQL:
 * DROP, ALTER EVENT … ENABLE/DISABLE, REFRESH MATERIALIZED VIEW or ALTER SEQUENCE … RESTART.
 */
export async function objectAction(
  connectionId: string,
  database: string,
  object: DbObject,
  action: ObjectStatementAction,
  options: { value?: string; preview?: boolean } = {},
): Promise<string> {
  if (desktop)
    return invoke("dbde_object_action", {
      connectionId,
      database,
      object,
      action,
      ...(options.value !== undefined ? { value: options.value } : {}),
      ...(options.preview ? { preview: true } : {}),
    });
  if (object.kind !== "trigger" || action !== "drop")
    throw new Error("This action is not available in the sandbox.");
  const sql = `DROP TRIGGER ${quoteIdentifier(object.name, "sqlite")}`;
  if (!options.preview) await execute(connectionId, sql, database);
  return sql;
}
/**
 * Saves text through the native save dialog in the desktop app (the backend writes the
 * file; the page never chooses a path) or as a browser download. Resolves to the saved
 * location, or null when the user cancels.
 */
export async function saveFile(
  defaultName: string,
  extension: "csv" | "sql" | "json" | "txt",
  contents: string,
): Promise<string | null> {
  if (desktop)
    return invoke("dbde_save_file", { defaultName, extension, contents });
  download(
    defaultName,
    new Blob([contents], {
      type: extension === "csv" ? "text/csv;charset=utf-8" : "text/plain",
    }),
  );
  return defaultName;
}
function download(name: string, blob: Blob) {
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = name;
  link.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function progressChannel(onProgress?: (rows: number) => void) {
  const channel = new Channel<{ rows: number }>();
  channel.onmessage = (message) => onProgress?.(message.rows);
  return channel;
}
// The sandbox builds the whole file in memory and downloads it; Excel needs the desktop app.
async function sandboxExport(
  options: ExportOptions,
  rows: unknown[][],
  name: string,
  sqlTarget: string,
  ddl: string,
  onProgress?: (rows: number) => void,
): Promise<ExportSummary> {
  if (options.format === "xlsx")
    throw new Error(
      "Excel export requires the desktop app. Choose CSV, TSV, JSON or SQL in the browser sandbox.",
    );
  const text = exportText(options, rows, "sqlite", sqlTarget, ddl);
  const format = EXPORT_FORMATS.find((f) => f.value === options.format)!;
  const fileName = `${name.replace(/[\\/:*?"<>|]/g, "_") || "export"}.${format.extension}`;
  download(
    fileName,
    new Blob([text], {
      type:
        options.format === "json"
          ? "application/json"
          : options.format === "sql"
            ? "text/plain"
            : "text/csv;charset=utf-8",
    }),
  );
  onProgress?.(rows.length);
  return { path: fileName, rows: rows.length, sheets: 1, truncated_cells: 0 };
}
/**
 * Exports a whole table, or the rows matching the grid's filters and sort. The desktop
 * backend asks for the destination in the native save dialog and streams rows into the
 * file; resolves to null when the save dialog or the export is cancelled.
 */
export async function exportTable(
  connectionId: string,
  database: string,
  table: TableInfo,
  options: ExportOptions,
  view: { filters?: TableFilter[]; sort?: TableSort },
  exportId: string,
  onProgress?: (rows: number) => void,
): Promise<ExportSummary | null> {
  const filters = view.filters ?? [];
  if (desktop)
    return invoke("dbde_export_table", {
      connectionId,
      database,
      table,
      options,
      ...(filters.length ? { filters } : {}),
      ...(view.sort ? { sort: view.sort } : {}),
      exportId,
      onProgress: progressChannel(onProgress),
    });
  const db = await demoDb();
  const names = (await columns(connectionId, table, database)).map(
    (c) => c.name,
  );
  if (options.columns.some((name) => !names.includes(name)))
    throw new Error("Unknown export column.");
  if (
    view.sort &&
    (!names.includes(view.sort.column) ||
      !["asc", "desc"].includes(view.sort.direction))
  )
    throw new Error("Unknown sort column or direction.");
  const clause = tableFilterClause(filters, "sqlite");
  const order = [
    ...(view.sort
      ? [
          `${quoteIdentifier(view.sort.column, "sqlite")} ${view.sort.direction.toUpperCase()}`,
        ]
      : []),
    ...(await viewTable(connectionId, database, table, 1, 1))
      .source!.primary_keys.filter((key) => key !== view.sort?.column)
      .map((key) => quoteIdentifier(key, "sqlite")),
  ];
  const target = quoteIdentifier(table.name, "sqlite");
  const statement = db.prepare(
    `SELECT ${options.columns.map((c) => quoteIdentifier(c, "sqlite")).join(", ")} FROM ${target}${clause.sql}${order.length ? ` ORDER BY ${order.join(", ")}` : ""}`,
  );
  const rows: unknown[][] = [];
  try {
    statement.bind(clause.values);
    while (statement.step())
      rows.push(
        statement.get().map((value) =>
          value instanceof Uint8Array
            ? {
                hex: Array.from(value, (b) =>
                  b.toString(16).padStart(2, "0"),
                ).join(""),
              }
            : value,
        ),
      );
  } finally {
    statement.free();
  }
  const ddl = options.create_table
    ? await tableDdl(connectionId, table, database)
    : "";
  return sandboxExport(options, rows, table.name, target, ddl, onProgress);
}
/**
 * Exports rows the grid already holds (selected rows, or a query's fetched rows). Each
 * row has one value per `options.columns` entry.
 */
export async function exportRows(
  connectionId: string,
  database: string | undefined,
  table: TableInfo | undefined,
  options: ExportOptions,
  rows: unknown[][],
  exportId: string,
  onProgress?: (rows: number) => void,
): Promise<ExportSummary | null> {
  if (rows.length > MAX_FETCHED_EXPORT_ROWS)
    throw new Error(
      `Export at most ${MAX_FETCHED_EXPORT_ROWS.toLocaleString()} fetched rows at once.`,
    );
  if (desktop)
    return invoke("dbde_export_rows", {
      connectionId,
      ...(database ? { database } : {}),
      ...(table ? { table } : {}),
      options,
      rows,
      exportId,
      onProgress: progressChannel(onProgress),
    });
  const target = table
    ? quoteIdentifier(table.name, "sqlite")
    : quoteIdentifier((options.table_name ?? "").trim() || "results", "sqlite");
  const ddl =
    options.create_table && table
      ? await tableDdl(connectionId, table, database)
      : "";
  return sandboxExport(
    options,
    rows,
    table?.name ?? "dbde-results",
    target,
    ddl,
    onProgress,
  );
}
/** Stops a running export; its partial file is deleted. */
export async function cancelExport(exportId: string): Promise<void> {
  if (desktop) await invoke("dbde_cancel_export", { exportId });
}
// Import wizard. The desktop app picks the file in the native open dialog and parses it
// in Rust; the webview only holds the opaque import ID. The browser sandbox reads the
// file with an <input type="file"> and imports it with sql.js.
const sandboxImports = new Map<
  string,
  { name: string; size: number; text: string }
>();
const sandboxRuns = new Map<string, { cancelled: boolean }>();
const SANDBOX_IMPORT_BYTES = 64 * 1024 * 1024;
function sandboxFormat(name: string, text: string): ImportFormat {
  const extension = name.toLowerCase().split(".").pop() ?? "";
  if (extension === "tsv" || extension === "tab") return "tsv";
  if (extension === "jsonl" || extension === "ndjson") return "jsonl";
  if (["xlsx", "xlsm", "xls", "xlsb", "ods"].includes(extension))
    return "excel";
  const start = text.replace(/^\uFEFF/, "").trimStart();
  if (extension === "json") return start.startsWith("{") ? "jsonl" : "json";
  const line = start.split("\n")[0] ?? "";
  if (extension === "txt" && line.includes("\t") && !line.includes(","))
    return "tsv";
  return "csv";
}
function sandboxPreview(
  importId: string,
  options: ImportParseOptions,
): ImportPreview {
  const file = sandboxImports.get(importId);
  if (!file)
    throw new Error(
      "This import file is no longer open. Choose the file again.",
    );
  const problem = parseOptionsError(options);
  if (problem) throw new Error(problem);
  const parsed = parseImportText(file.text, options);
  return {
    import_id: importId,
    file_name: file.name,
    file_size: file.size,
    options: { ...options, sheet: undefined },
    sheets: [],
    columns: parsed.columns,
    rows: parsed.rows
      .filter((row) => row !== null)
      .slice(0, 50)
      .map((row) =>
        parsed.columns.map((_, i) => {
          const value = row![i];
          return value === undefined || value === null ? null : String(value);
        }),
      ),
    row_errors: parsed.errors.slice(0, 50),
    estimated_rows: parsed.rows.length,
    exact_rows: true,
  };
}
/** Opens a data file (CSV, TSV, JSON, JSON Lines or Excel) and previews it; null when cancelled. */
export async function openImportFile(): Promise<ImportPreview | null> {
  if (desktop) return invoke("dbde_import_open");
  const file = await new Promise<File | null>((resolve) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".csv,.tsv,.tab,.txt,.json,.jsonl,.ndjson";
    input.style.display = "none";
    document.body.appendChild(input);
    input.oncancel = () => {
      input.remove();
      resolve(null);
    };
    input.onchange = () => {
      const picked = input.files?.[0] ?? null;
      input.remove();
      resolve(picked);
    };
    input.click();
  });
  if (!file) return null;
  if (/\.(xlsx|xlsm|xls|xlsb|ods)$/i.test(file.name))
    throw new Error(
      "Excel import requires the desktop app. Save the sheet as CSV to import it in the browser sandbox.",
    );
  if (file.size > SANDBOX_IMPORT_BYTES)
    throw new Error(
      "Files in the browser sandbox must not exceed 64 MB. Use the desktop app for larger files.",
    );
  const text = await file.text();
  if (text.includes("\0"))
    throw new Error("Choose a UTF-8 text file (CSV, TSV or JSON).");
  const id = crypto.randomUUID().replaceAll("-", "");
  sandboxImports.set(id, { name: file.name, size: file.size, text });
  try {
    return sandboxPreview(
      id,
      defaultParseOptions(sandboxFormat(file.name, text)),
    );
  } catch (cause) {
    sandboxImports.delete(id);
    throw cause;
  }
}
/** Parses the opened file again with new options. */
export async function previewImport(
  importId: string,
  options: ImportParseOptions,
): Promise<ImportPreview> {
  if (desktop) return invoke("dbde_import_preview", { importId, options });
  return sandboxPreview(importId, options);
}
/** Forgets the opened file. */
export async function closeImport(importId: string): Promise<void> {
  if (desktop) await invoke("dbde_import_close", { importId });
  else sandboxImports.delete(importId);
}
/** Columns (type, NOT NULL, default), primary key and engine of the target table. */
export async function importTarget(
  connectionId: string,
  database: string,
  table: TableInfo,
): Promise<ImportTarget> {
  if (desktop)
    return invoke("dbde_import_target", { connectionId, database, table });
  if (table.kind !== "table")
    throw new Error("Data can only be imported into a table.");
  const db = await demoDb();
  const info = db.exec(
    `SELECT name, type, "notnull", dflt_value IS NOT NULL, hidden, pk FROM pragma_table_xinfo(?)`,
    [table.name],
  )[0];
  const rows = info?.values ?? [];
  if (!rows.length) throw new Error(`No columns found for ${table.name}.`);
  const keys = rows
    .filter((r) => Number(r[5]) > 0)
    .sort((a, b) => Number(a[5]) - Number(b[5]))
    .map((r) => String(r[0]));
  return {
    columns: rows.map((r) => ({
      name: String(r[0]),
      data_type: String(r[1]),
      nullable: !Number(r[2]),
      has_default:
        !!Number(r[3]) ||
        (keys.length === 1 &&
          Number(r[5]) > 0 &&
          String(r[1]).toUpperCase() === "INTEGER"),
      generated: !!Number(r[4]),
    })),
    primary_keys: keys,
    transactional: true,
  };
}
/** Exact row count, shown when confirming a Copy import. */
export async function importRowCount(
  connectionId: string,
  database: string,
  table: TableInfo,
): Promise<number> {
  if (desktop)
    return invoke("dbde_import_count", { connectionId, database, table });
  const db = await demoDb();
  return Number(
    db.exec(`SELECT COUNT(*) FROM ${quoteIdentifier(table.name, "sqlite")}`)[0]
      .values[0][0],
  );
}
/**
 * Imports the opened file into a table in one transaction. Resolves to null when
 * cancelled (everything is rolled back).
 */
export async function runImport(
  connectionId: string,
  database: string,
  table: TableInfo,
  importId: string,
  request: ImportRequest,
  onProgress?: (rows: number) => void,
): Promise<ImportSummary | null> {
  if (desktop)
    return invoke("dbde_import_run", {
      connectionId,
      database,
      table,
      importId,
      request,
      onProgress: progressChannel(onProgress),
    });
  if (sandboxRuns.has(importId))
    throw new Error("This import is already running");
  const run = { cancelled: false };
  sandboxRuns.set(importId, run);
  try {
    return await sandboxImport(
      connectionId,
      database,
      table,
      importId,
      request,
      run,
      onProgress,
    );
  } finally {
    sandboxRuns.delete(importId);
  }
}
async function sandboxImport(
  connectionId: string,
  database: string,
  table: TableInfo,
  importId: string,
  request: ImportRequest,
  run: { cancelled: boolean },
  onProgress?: (rows: number) => void,
): Promise<ImportSummary | null> {
  const file = sandboxImports.get(importId);
  if (!file)
    throw new Error(
      "This import file is no longer open. Choose the file again.",
    );
  const problem = parseOptionsError(request.options);
  if (problem) throw new Error(problem);
  const target = await importTarget(connectionId, database, table);
  for (const { target: name } of request.mapping) {
    const column = target.columns.find((c) => c.name === name);
    if (!column) throw new Error(`Unknown column ${name}`);
    if (column.generated)
      throw new Error(`${name} is a generated column and cannot be imported.`);
  }
  const invalid = mappingError(
    target,
    request.mapping,
    request.mode,
    request.continue_on_error,
  );
  if (invalid) throw new Error(invalid);
  const parsed = parseImportText(file.text, request.options);
  if (parsed.rows.length > MAX_IMPORT_ROWS)
    throw new Error(
      `The file has more than ${MAX_IMPORT_ROWS} rows. Split it and import at most ${MAX_IMPORT_ROWS} rows at a time.`,
    );
  const picks = request.mapping.map((m) => {
    const index = parsed.columns.indexOf(m.source);
    if (index < 0) throw new Error(`The file has no column named ${m.source}.`);
    return index;
  });
  const q = (name: string) => quoteIdentifier(name, "sqlite");
  const targetName = q(table.name);
  const columns = request.mapping.map((m) => m.target);
  const keys = target.primary_keys.map((key) => columns.indexOf(key));
  const others = columns.map((_, i) => i).filter((i) => !keys.includes(i));
  const insert = `INSERT INTO ${targetName} (${columns.map(q).join(", ")}) VALUES (${columns.map(() => "?").join(", ")})`;
  const keyCondition = keys.map((k) => `${q(columns[k])} = ?`).join(" AND ");
  const sql =
    request.mode === "update"
      ? `UPDATE ${targetName} SET ${others.map((i) => `${q(columns[i])} = ?`).join(", ")} WHERE ${keyCondition}`
      : request.mode === "upsert"
        ? `${insert} ON CONFLICT (${keys.map((k) => q(columns[k])).join(", ")}) ${others.length ? `DO UPDATE SET ${others.map((i) => `${q(columns[i])} = excluded.${q(columns[i])}`).join(", ")}` : "DO NOTHING"}`
        : insert;
  const exists = `SELECT COUNT(*) FROM ${targetName} WHERE ${keyCondition}`;
  const summary: ImportSummary = {
    rows: 0,
    inserted: 0,
    updated: 0,
    skipped: 0,
    failed: 0,
    deleted: 0,
    errors: [],
    more_errors: 0,
  };
  const note = (row: number, message: string) => {
    if (summary.errors.length < MAX_ERRORS)
      summary.errors.push({ row, message });
    else summary.more_errors++;
  };
  const fail = (row: number, message: string) => {
    if (!request.continue_on_error) throw new Error(`Row ${row}: ${message}`);
    summary.failed++;
    note(row, message);
  };
  const parseErrors = new Map(parsed.errors.map((e) => [e.row, e.message]));
  const db = await demoDb();
  db.run("BEGIN");
  try {
    if (request.mode === "copy") {
      db.run(`DELETE FROM ${targetName}`);
      summary.deleted = db.getRowsModified();
    }
    for (let i = 0; i < parsed.rows.length; i++) {
      const row = i + 1;
      summary.rows = row;
      if (i % 500 === 0) {
        onProgress?.(i);
        await new Promise((resolve) => setTimeout(resolve));
        if (run.cancelled) throw new Error("cancelled");
      }
      const cells = parsed.rows[i];
      if (!cells) {
        fail(row, parseErrors.get(row) ?? "Could not parse this row.");
        continue;
      }
      const values = picks.map((index) => {
        const value = cells[index];
        return value === undefined || value === null
          ? null
          : typeof value === "boolean"
            ? Number(value)
            : value;
      });
      if (request.continue_on_error) db.run("SAVEPOINT dbde_import");
      try {
        if (request.mode === "update") {
          db.run(sql, [
            ...others.map((k) => values[k]),
            ...keys.map((k) => values[k]),
          ]);
          if (db.getRowsModified()) summary.updated++;
          else {
            summary.skipped++;
            note(row, "No row with this primary key; skipped.");
          }
        } else if (request.mode === "upsert") {
          const found = Number(
            db.exec(
              exists,
              keys.map((k) => values[k]),
            )[0].values[0][0],
          );
          db.run(sql, values);
          if (!found) summary.inserted++;
          else if (others.length) summary.updated++;
          else summary.skipped++;
        } else {
          db.run(sql, values);
          summary.inserted++;
        }
        if (request.continue_on_error) db.run("RELEASE SAVEPOINT dbde_import");
      } catch (cause) {
        if (request.continue_on_error) {
          db.run("ROLLBACK TO SAVEPOINT dbde_import");
          db.run("RELEASE SAVEPOINT dbde_import");
        }
        fail(row, String(cause).replace(/^Error: /, ""));
      }
    }
    if (run.cancelled) throw new Error("cancelled");
    db.run("COMMIT");
    onProgress?.(summary.rows);
    return summary;
  } catch (cause) {
    db.run("ROLLBACK");
    if (run.cancelled) return null;
    const message = String(cause).replace(/^Error: /, "");
    throw new Error(
      `${message.endsWith(".") ? message : message + "."} Nothing was imported.`,
    );
  }
}
/** Stops a running import; it is rolled back. */
export async function cancelImport(importId: string): Promise<void> {
  if (desktop) await invoke("dbde_cancel_import", { importId });
  else {
    const run = sandboxRuns.get(importId);
    if (run) run.cancelled = true;
  }
}
export const closeSession = (
  connectionId: string,
  sessionId: string,
): Promise<void> =>
  desktop
    ? invoke("dbde_close_session", { connectionId, sessionId })
    : Promise.resolve();
export async function disconnect(connectionId: string): Promise<void> {
  if (desktop) await invoke("dbde_disconnect", { connectionId });
  for (const [key, entry] of connections) {
    if (entry.id === connectionId) connections.delete(key);
  }
}

/** Create a new table; existing targets are never replaced. */
export async function copyTable(
  connectionId: string,
  database: string,
  table: TableInfo,
  target: TableInfo,
  data: boolean,
): Promise<void> {
  if (desktop)
    return invoke("dbde_copy_table", {
      connectionId,
      database,
      table,
      target,
      data,
    });
  if (
    table.kind !== "table" ||
    !target.name.trim() ||
    target.name.length > 128 ||
    target.name.includes("\0")
  )
    throw new Error("Choose a valid new table name.");
  if (target.schema && target.schema !== "main")
    throw new Error("SQLite copies stay in the current database.");
  const db = await demoDb();
  const stmt = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?",
  );
  let ddl = "";
  try {
    stmt.bind([table.name]);
    if (stmt.step()) ddl = String(stmt.get()[0]);
  } finally {
    stmt.free();
  }
  if (!ddl) throw new Error("Table not found.");
  const targetSql = quoteIdentifier(target.name, "sqlite");
  const indexes = db.prepare(
    "SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL ORDER BY name",
  );
  const definitions: string[] = [];
  try {
    indexes.bind([table.name]);
    while (indexes.step()) definitions.push(String(indexes.get()[0]));
  } finally {
    indexes.free();
  }
  const body = (sql: string) => {
    let quoted = "";
    for (let i = 0; i < sql.length; i++) {
      const ch = sql[i];
      if (quoted) {
        if (ch === quoted) quoted = "";
      } else if (["'", '"', "`", "["].includes(ch))
        quoted = ch === "[" ? "]" : ch;
      else if (ch === "(") return sql.slice(i);
    }
    throw new Error("Cannot read table definition.");
  };
  const names = (await exportColumns(connectionId, database, table))
    .map((n) => quoteIdentifier(n, "sqlite"))
    .join(", ");
  db.run("BEGIN");
  try {
    db.run(`CREATE TABLE ${targetSql} ${body(ddl)}`);
    definitions.forEach((index, i) =>
      db.run(
        `CREATE ${/^CREATE\s+UNIQUE\s+INDEX/i.test(index) ? "UNIQUE " : ""}INDEX ${quoteIdentifier(`${target.name}_copy_index_${i + 1}`, "sqlite")} ON ${targetSql} ${body(index)}`,
      ),
    );
    if (data)
      db.run(
        `INSERT INTO ${targetSql} (${names}) SELECT ${names} FROM ${quoteIdentifier(table.name, "sqlite")}`,
      );
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}
/** Copies a whole table into the database selected by the destination list tab. */
export async function pasteTable(
  sourceConnectionId: string,
  sourceDatabase: string,
  table: TableInfo,
  targetConnectionId: string,
  targetDatabase: string,
  target: TableInfo,
  data: boolean,
): Promise<void> {
  if (desktop)
    return invoke("dbde_copy_table", {
      connectionId: sourceConnectionId,
      database: sourceDatabase,
      table,
      target,
      data,
      destination: {
        connectionId: targetConnectionId,
        database: targetDatabase,
      },
    });
  if (
    sourceConnectionId !== targetConnectionId ||
    sourceDatabase !== targetDatabase
  )
    throw new Error("Copying to another database requires the desktop app.");
  await copyTable(sourceConnectionId, sourceDatabase, table, target, data);
}
export async function clearTable(
  connectionId: string,
  database: string,
  table: TableInfo,
  resetIdentity: boolean,
): Promise<void> {
  if (table.kind !== "table")
    throw new Error("Views cannot be emptied or truncated.");
  if (desktop)
    return invoke("dbde_clear_table", {
      connectionId,
      database,
      table,
      resetIdentity,
    });
  const db = await demoDb();
  db.run("BEGIN");
  try {
    db.run(`DELETE FROM ${quoteIdentifier(table.name, "sqlite")}`);
    if (
      resetIdentity &&
      db.exec("SELECT name FROM sqlite_master WHERE name = 'sqlite_sequence'")
        .length
    )
      db.run("DELETE FROM sqlite_sequence WHERE name = ?", [table.name]);
    db.run("COMMIT");
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}
/** Renames a table or view in its schema; resolves to the renamed table. */
export async function renameTable(
  connectionId: string,
  database: string,
  table: TableInfo,
  newName: string,
): Promise<TableInfo> {
  if (desktop)
    return invoke("dbde_rename_table", {
      connectionId,
      database,
      table,
      newName,
    });
  const error = tableNameError(table, newName, "sqlite");
  if (error) throw new Error(error);
  await execute(
    connectionId,
    renameTableSql(table, newName, "sqlite"),
    database,
  );
  return { ...table, name: newName };
}
export async function dropTable(
  connectionId: string,
  database: string,
  table: TableInfo,
  foreignKeyChecks: ForeignKeyChecks = "default",
): Promise<void> {
  if (desktop)
    return invoke("dbde_drop_table", {
      connectionId,
      database,
      table,
      foreignKeyChecks,
    });
  if (foreignKeyChecks !== "default")
    throw new Error(
      "Foreign Key Checks overrides are supported only for MySQL/MariaDB tables.",
    );
  await execute(
    connectionId,
    tableActionSql("drop", table, "sqlite"),
    database,
  );
}
export async function exportColumns(
  connectionId: string,
  database: string,
  table: TableInfo,
): Promise<string[]> {
  if (desktop)
    return invoke("dbde_export_columns", { connectionId, database, table });
  const db = await demoDb();
  const stmt = db.prepare(
    "SELECT name FROM pragma_table_xinfo(?) WHERE hidden = 0 ORDER BY cid",
  );
  const names: string[] = [];
  try {
    stmt.bind([table.name]);
    while (stmt.step()) names.push(String(stmt.get()[0]));
  } finally {
    stmt.free();
  }
  return names;
}

export async function loadRecord(
  connectionId: string,
  source: TableSource,
  row: unknown[],
  columns: string[],
): Promise<unknown[]> {
  const key = Object.fromEntries(
    source.primary_keys.map((name) => [name, row[columns.indexOf(name)]]),
  );
  if (desktop)
    return invoke("dbde_load_record", {
      connectionId,
      database: source.database,
      table: source.table,
      key,
    });
  if (
    !source.primary_keys.length ||
    Object.values(key).some((v) => v == null || typeof v === "object")
  )
    throw new Error("A complete scalar primary key is required.");
  const db = await demoDb();
  const stmt = db.prepare(
    `SELECT * FROM ${quoteIdentifier(source.table.name, "sqlite")} WHERE ${source.primary_keys.map((name) => `${quoteIdentifier(name, "sqlite")} = ?`).join(" AND ")} LIMIT 1`,
  );
  try {
    stmt.bind(source.primary_keys.map((name) => key[name] as string | number));
    if (!stmt.step())
      throw new Error("This record no longer exists. Refresh the table.");
    return stmt.get();
  } finally {
    stmt.free();
  }
}

export interface DatabaseChange {
  name: string;
  charset: string;
  collation: string;
}
export async function manageDatabase(
  connectionId: string,
  database: string,
  action: "create" | "edit" | "delete",
  change: DatabaseChange,
): Promise<void> {
  if (!desktop)
    throw new Error(
      "Database administration requires a desktop server connection.",
    );
  return invoke("dbde_manage_database", {
    connectionId,
    database,
    action,
    change,
  });
}
export async function closeDatabase(
  connectionId: string,
  database: string,
): Promise<void> {
  if (desktop) await invoke("dbde_close_database", { connectionId, database });
}
export async function openSqlFile(): Promise<{
  name: string;
  contents: string;
} | null> {
  if (desktop) return invoke("dbde_open_sql_file");
  return new Promise((resolve, reject) => {
    const input = document.createElement("input");
    input.type = "file";
    input.accept = ".sql";
    input.style.display = "none";
    document.body.appendChild(input);
    input.oncancel = () => {
      input.remove();
      resolve(null);
    };
    input.onchange = async () => {
      const file = input.files?.[0];
      input.remove();
      if (!file) return resolve(null);
      if (file.size > 20 * 1024 * 1024)
        return reject(new Error("SQL files must not exceed 20 MB."));
      try {
        const contents = (await file.text()).replace(/^\uFEFF/, "");
        if (contents.includes("\0")) throw new Error("Choose a SQL text file.");
        resolve({ name: file.name, contents });
      } catch (e) {
        reject(e);
      }
    };
    input.click();
  });
}

/** Creates a new table; the native command applies transactional DDL where supported. */
export async function createTable(
  connectionId: string,
  database: string,
  design: TableDesign,
): Promise<TableInfo> {
  const driver =
    useWorkspace
      .getState()
      .sessions.find((session) => session.id === connectionId)?.config.driver ??
    (desktop ? undefined : "sqlite");
  if (!driver)
    throw new Error(
      "Connection is no longer available. Reconnect before creating the table.",
    );
  const plan = buildTablePlan(design, driver, database);
  if (desktop)
    await invoke("dbde_create_table", {
      connectionId,
      database,
      statements: plan.statements,
    });
  else {
    const db = await demoDb();
    db.run("BEGIN");
    try {
      for (const statement of plan.statements) db.run(statement);
      db.run("COMMIT");
    } catch (cause) {
      db.run("ROLLBACK");
      throw cause;
    }
  }
  return plan.table;
}

/* Query history, saved queries and snippets. The desktop backend owns the files
 * (one writer for every window); the sandbox keeps them in localStorage. */
export type LibraryKind = "saved_queries" | "snippets";
export type LibraryChange =
  | { kind: "history"; op: "append"; entry: unknown }
  | { kind: "history" | LibraryKind; op: "reload" };
export const LIBRARY_CHANGE_EVENT = "dbde://query-library";
const sandboxKey = (kind: "history" | LibraryKind) => `dbde.sandbox.${kind}`;
function sandboxRead(kind: "history" | LibraryKind): unknown[] {
  try {
    const list = JSON.parse(localStorage.getItem(sandboxKey(kind)) ?? "[]");
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
}
function sandboxWrite(kind: "history" | LibraryKind, list: unknown[]) {
  try {
    localStorage.setItem(sandboxKey(kind), JSON.stringify(list));
  } catch {
    throw new Error("Browser storage is full or unavailable.");
  }
}
const idOf = (value: unknown) => (value as { id?: unknown })?.id;
export async function listHistory(): Promise<unknown[]> {
  if (desktop) return invoke("dbde_history_list");
  return sandboxRead("history");
}
export async function appendHistory(entry: HistoryEntry): Promise<void> {
  if (desktop) return invoke("dbde_history_append", { entry });
  sandboxWrite(
    "history",
    capHistory(
      [...readHistory(sandboxRead("history")), entry],
      MAX_HISTORY_ENTRIES,
      SANDBOX_HISTORY_BYTES,
    ),
  );
}
export async function deleteHistory(ids: string[]): Promise<void> {
  if (desktop) return invoke("dbde_history_delete", { ids });
  sandboxWrite(
    "history",
    sandboxRead("history").filter((e) => !ids.includes(idOf(e) as string)),
  );
}
export async function clearHistory(): Promise<void> {
  if (desktop) return invoke("dbde_history_clear");
  sandboxWrite("history", []);
}
export async function listLibrary(kind: LibraryKind): Promise<unknown[]> {
  if (desktop) return invoke("dbde_library_list", { kind });
  return sandboxRead(kind);
}
/** Inserts or replaces items by id. */
export async function saveLibraryItems(
  kind: LibraryKind,
  items: { id: string }[],
): Promise<void> {
  if (desktop) return invoke("dbde_library_save", { kind, items });
  const stored = sandboxRead(kind);
  for (const item of items) {
    const index = stored.findIndex((old) => idOf(old) === item.id);
    if (index >= 0) stored[index] = item;
    else stored.push(item);
  }
  sandboxWrite(kind, stored);
}
export async function deleteLibraryItems(
  kind: LibraryKind,
  ids: string[],
): Promise<void> {
  if (desktop) return invoke("dbde_library_delete", { kind, ids });
  sandboxWrite(
    kind,
    sandboxRead(kind).filter((item) => !ids.includes(idOf(item) as string)),
  );
}
/** Calls `listener` when another window (or the backend) changes the library. */
export async function onLibraryChange(
  listener: (change: LibraryChange) => void,
): Promise<() => void> {
  if (desktop) {
    const { listen } = await import("@tauri-apps/api/event");
    return listen<LibraryChange>(LIBRARY_CHANGE_EVENT, (event) =>
      listener(event.payload),
    );
  }
  const kinds = ["history", "saved_queries", "snippets"] as const;
  const sync = (event: StorageEvent) => {
    const kind = kinds.find((k) => event.key === sandboxKey(k));
    if (kind) listener({ kind, op: "reload" });
  };
  window.addEventListener("storage", sync);
  return () => window.removeEventListener("storage", sync);
}

/** Evaluate a supported Raw Mode function for exactly one existing record. */
export async function updateRawCell(
  connectionId: string,
  source: TableSource,
  key: Record<string, unknown>,
  column: string,
  value: string,
): Promise<number> {
  const driver =
    useWorkspace.getState().sessions.find((s) => s.id === connectionId)?.config
      .driver ?? "sqlite";
  const { rawExpression } = await import("./raw-mode");
  const expression = rawExpression(value, driver);
  if (desktop)
    return invoke("dbde_raw_cell", {
      connectionId,
      database: source.database,
      table: source.table,
      key,
      column,
      expression,
    });
  const actual = await viewTable(
    connectionId,
    source.database,
    source.table,
    1,
    1,
  );
  const keys = actual.source?.primary_keys ?? [];
  if (
    source.table.kind !== "table" ||
    !actual.columns.includes(column) ||
    keys.includes(column) ||
    !keys.length ||
    Object.keys(key).length !== keys.length ||
    keys.some((k) => key[k] == null || typeof key[k] === "object")
  )
    throw new Error("A complete primary key and editable field are required.");
  const db = await demoDb();
  db.run("BEGIN");
  try {
    db.run(
      `UPDATE ${quoteIdentifier(source.table.name, "sqlite")} SET ${quoteIdentifier(column, "sqlite")} = ${expression} WHERE ${keys.map((k) => `${quoteIdentifier(k, "sqlite")} = ?`).join(" AND ")}`,
      keys.map((k) => String(key[k])),
    );
    const changed = db.getRowsModified();
    if (changed !== 1)
      throw new Error("The record no longer exists. Refresh and try again.");
    db.run("COMMIT");
    return changed;
  } catch (e) {
    db.run("ROLLBACK");
    throw e;
  }
}
