export type Driver = "postgres" | "mysql" | "sqlite";
export interface ConnectionConfig {
  id: string;
  name: string;
  driver: Driver;
  host: string;
  port: number;
  username: string;
  password?: string;
  database: string;
  ssl_mode: "disable" | "require" | "verify-full";
  file_path: string;
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
}
export interface SchemaTree {
  database: string;
  tables: TableInfo[];
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
}
export interface TableSource {
  filters?: TableFilter[];
  sort?: TableSort;
  table: TableInfo;
  database: string;
  primary_keys: string[];
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
  column: string;
  operator: FilterOperator;
  value: string;
}
export interface Session {
  id: string;
  config: ConnectionConfig;
  databases?: string[];
  trees?: Record<string, SchemaTree>;
  loading?: boolean;
  error?: string;
}
export interface QueryTab {
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
}
