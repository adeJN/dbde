export type Driver = "postgres" | "mysql" | "sqlite";
export type ForeignKeyChecks = "default" | "enable" | "disable";
export interface ConnectionConfig {
  options?: ConnectionOptions;
  id: string;
  name: string;
  driver: Driver;
  host: string;
  port: number;
  username: string;
  password?: string;
  database: string;
  /** Limit the connection's explorer to its selected database. Older profiles browse all. */
  database_only?: boolean;
  ssl_mode: "disable" | "require" | "verify-full";
  file_path: string;
}
export interface ConnectionOptions {
  custom_database_list?: boolean;
  database_list?: { name: string; auto_open: boolean }[];
  ssh?: SshOptions;
  connect_timeout_secs?: number;
  query_timeout_secs?: number;
  session_limit?: number;
  charset?: string;
  socket_path?: string;
  ssl_ca?: string;
  ssl_cert?: string;
  ssl_key?: string;
  initial_queries?: string;
  auto_connect?: boolean;
  remarks?: string;
}
export interface SshOptions {
  enabled?: boolean;
  host?: string;
  port?: number;
  username?: string;
  auth?: "password" | "private_key";
  private_key?: string;
  fingerprint?: string;
  /** SSH password or private-key passphrase; never stored in profile JSON. */
  password?: string;
}
export interface TableInfo {
  name: string;
  schema: string;
  kind: string;
}
export interface ColumnInfo {
  name: string;
  data_type: string;
  nullable: boolean;
  /** Allowed values of a MySQL/MariaDB ENUM or PostgreSQL enum type, in order. */
  enum_values?: string[];
  /** Members of a MySQL/MariaDB SET column, in definition order. */
  set_values?: string[];
  /** PostgreSQL boolean, MySQL BOOL (tinyint(1)) or SQLite BOOLEAN. */
  is_boolean?: boolean;
}
/** A foreign key: `columns[i]` references `referenced_columns[i]`. */
export interface ForeignKeyInfo {
  name: string;
  columns: string[];
  referenced_table: TableInfo;
  referenced_columns: string[];
}
export interface SchemaTree {
  database: string;
  tables: TableInfo[];
  table_metadata?: TableMetadata[];
}
export interface TableMetadata {
  name: string;
  schema: string;
  rows: number | null;
  data_length: number | null;
  engine: string | null;
  created_date: string | null;
  modified_date: string | null;
  collation: string | null;
  comment: string | null;
}
export interface QueryResult {
  pagination?: TablePagination;
  columns: string[];
  rows: unknown[][];
  affected_rows: number;
  execution_ms: number;
  truncated: boolean;
  source?: TableSource;
}
export interface TablePagination {
  page: number;
  page_size: number;
  total_rows: number;
  /** Set when total_rows is the planner's estimate for a very large table. */
  estimated?: boolean;
  /** Whether the server fetched a row beyond this page, when counts are estimated. */
  has_next?: boolean;
}
export interface IndexInfo {
  name: string;
  columns: string[];
  unique: boolean;
  primary: boolean;
}
export interface TableSource {
  quick?: boolean;
  filters?: TableFilter[];
  sort?: TableSort;
  table: TableInfo;
  database: string;
  primary_keys: string[];
}
export interface TableShortcut {
  profile_id: string;
  database: string;
  table: TableInfo;
}
export interface ColumnMapping {
  source: string;
  target: string;
}
export interface TableSort {
  column: string;
  direction: "asc" | "desc";
}
export type FilterOperator =
  | "equals"
  | "not_equals"
  | "contains"
  | "not_contains"
  | "starts_with"
  | "ends_with"
  | "is_null"
  | "is_not_null";
export interface TableFilter {
  /** Connector to the preceding condition; defaults to AND. */
  join?: "and" | "or";
  column: string;
  operator: FilterOperator;
  value: string;
}
export interface Session {
  explorerVersion?: number;
  id: string;
  config: ConnectionConfig;
  databases?: string[];
  trees?: Record<string, SchemaTree>;
  /** Routines, triggers, events, sequences and materialized views, loaded per kind on demand. */
  objects?: Record<string, Partial<Record<ObjectKind, DbObject[]>>>;
  loading?: boolean;
  error?: string;
}
export interface QueryTab {
  /** Forces fresh field metadata after saving changes to a table definition. */
  schemaVersion?: number;
  favoriteId?: string;
  /** The saved query this tab edits (its name is the tab title). */
  savedQueryId?: string;
  /** SQL as last saved or opened, to tell whether the tab has unsaved edits. */
  savedQuerySql?: string;
  kind?: "database";
  editorOpen?: boolean;
  tableIdentity?: { database: string; schema: string; name: string };
  id: string;
  name: string;
  connectionId: string;
  database?: string;
  query: string;
  result?: QueryResult;
  error?: string;
  running: boolean;
  /** True while an editor query runs on this tab's own server session. */
  cancellable?: boolean;
  timeoutSecs?: number;
  /** Unsaved table edits, kept here so they survive switching tabs. */
  staged?: StagedChanges;
  /** The last query plan from Explain, shown in the Plan view. */
  plan?: TabPlan;
  /** Which result view is in front when a plan exists. */
  resultView?: "result" | "plan";
  /** Explain with ANALYZE (runs the statement; writes are rolled back). */
  explainAnalyze?: boolean;
}
/** Output of dbde_explain_query; see src-tauri/src/explain.rs. */
export interface ExplainOutput {
  /** "json": raw holds the plan document; "tree": MySQL's text tree; "table": rows. */
  format: "json" | "tree" | "table";
  sql: string;
  raw: string;
  columns: string[];
  rows: unknown[][];
  analyzed: boolean;
  /** ANALYZE ran inside a transaction or savepoint that was rolled back. */
  rolled_back: boolean;
  server_version: string;
  execution_ms: number;
}
export interface TabPlan {
  output: ExplainOutput;
  statement: string;
  driver: Driver;
}
/** A staged data-editor change, applied with others in one transaction. */
export type RecordChange =
  | {
      kind: "update";
      key: Record<string, unknown>;
      values: Record<string, string | null>;
    }
  | { kind: "insert"; values: Record<string, string | null> }
  | { kind: "delete"; key: Record<string, unknown> };
/** A record waiting to be inserted. Missing columns use their default; null is NULL. */
export interface DraftRecord {
  key: string;
  values: Record<string, string | null>;
  /** True for a copy or pasted row; the last draft is always the blank entry row. */
  copy?: boolean;
}
/** A staged update of one existing record, identified by its full primary key. */
export interface StagedEdit {
  key: Record<string, unknown>;
  values: Record<string, string | null>;
}
/**
 * Data-editor changes not yet written. Existing records are keyed by their primary key
 * (see recordId), never by row position, so a reload, page change or replaced result
 * can never redirect an edit or deletion to a different record.
 */
export interface StagedChanges {
  edits: Record<string, StagedEdit>;
  /** Records marked for deletion inside a transaction. */
  deletes: Record<string, Record<string, unknown>>;
  drafts: DraftRecord[];
  /** While true nothing is written until Commit; Rollback discards everything. */
  transaction: boolean;
}
export type ObjectKind =
  | "function"
  | "procedure"
  | "trigger"
  | "event"
  | "sequence"
  | "materialized_view";
/** A database object other than a table or view, as listed by the backend. */
export interface DbObject {
  kind: ObjectKind;
  schema: string;
  name: string;
  /** The table a trigger belongs to. */
  table?: string;
  /** PostgreSQL argument types of an overloaded function or procedure. */
  signature?: string;
  detail?: string;
  /** Event ENABLED/DISABLED, trigger state, or materialized view population. */
  status?: string;
  /** "trigger" for PostgreSQL trigger functions. */
  flag?: string;
  last_value?: string;
  increment?: string;
  start?: string;
  comment?: string;
  refresh_concurrently?: boolean;
}
export interface ObjectDefinition {
  definition: string;
  edit_script: string;
  execute_script?: string;
  note?: string;
}
export type ObjectStatementAction =
  | "drop"
  | "enable"
  | "disable"
  | "refresh"
  | "refresh_concurrently"
  | "restart";
