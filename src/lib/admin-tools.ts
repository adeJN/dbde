import type { Driver, QueryResult, TableInfo } from "../types";
import { qualifiedName, quoteIdentifier } from "./sql";

export type MonitorSection = "Processes" | "Variables" | "Status";
export function monitorSql(driver: Driver, section: MonitorSection): string {
  if (driver === "sqlite")
    return section === "Variables"
      ? "PRAGMA compile_options;"
      : section === "Status"
        ? "PRAGMA database_list;"
        : "SELECT 'SQLite has no server process list' AS information;";
  if (driver === "mysql")
    return section === "Processes"
      ? "SHOW FULL PROCESSLIST;"
      : section === "Variables"
        ? "SHOW GLOBAL VARIABLES;"
        : "SHOW GLOBAL STATUS;";
  return section === "Processes"
    ? "SELECT pid, usename, datname, application_name, client_addr::text, state, query_start::text, wait_event_type, wait_event, query FROM pg_stat_activity ORDER BY query_start NULLS LAST;"
    : section === "Variables"
      ? "SELECT name, setting, unit, category, source FROM pg_settings ORDER BY name;"
      : "SELECT datname, numbackends, xact_commit, xact_rollback, blks_read, blks_hit, tup_returned, tup_fetched, deadlocks FROM pg_stat_database ORDER BY datname;";
}
export function killQuerySql(driver: Driver, id: string): string {
  if (!/^[1-9]\d{0,15}$/.test(id) || !Number.isSafeInteger(Number(id)))
    throw new Error("Choose a valid server process ID.");
  if (driver === "sqlite")
    throw new Error("SQLite has no server queries to cancel.");
  return driver === "mysql"
    ? `KILL QUERY ${id};`
    : `SELECT pg_cancel_backend(${id});`;
}
// SQL account syntax requires a literal, rather than an arbitrary expression. Names
// with backslashes are rejected so quoting is independent of MySQL sql_mode.
export function accountSql(driver: Driver, name: string, host = "localhost") {
  if (!name.trim() || /[\0\\]/.test(name + host))
    throw new Error("Enter an account name without NUL or backslashes.");
  const literal = (s: string) => `'${s.replaceAll("'", "''")}'`;
  return driver === "mysql"
    ? `${literal(name)}@${literal(host)}`
    : quoteIdentifier(name, driver);
}
export function usersSql(driver: Driver) {
  if (driver === "sqlite")
    throw new Error(
      "SQLite uses file permissions; it has no server users or roles.",
    );
  return driver === "mysql"
    ? "SELECT User, Host, plugin FROM mysql.user ORDER BY User, Host;"
    : "SELECT rolname, rolcanlogin, rolsuper, rolcreatedb, rolcreaterole, rolconnlimit FROM pg_roles ORDER BY rolname;";
}
export function grantsSql(driver: Driver, name: string, host: string) {
  const account = accountSql(driver, name, host);
  return driver === "mysql"
    ? `SHOW GRANTS FOR ${account};`
    : `SELECT grantee, table_schema, table_name, privilege_type, is_grantable FROM information_schema.table_privileges WHERE grantee = '${name.replaceAll("'", "''")}' ORDER BY table_schema, table_name, privilege_type;`;
}
export const PRIVILEGES = [
  "SELECT",
  "INSERT",
  "UPDATE",
  "DELETE",
  "REFERENCES",
  "TRIGGER",
  "ALL PRIVILEGES",
] as const;
export function privilegeSql(
  driver: Driver,
  action: "GRANT" | "REVOKE",
  name: string,
  host: string,
  database: string,
  schema: string,
  table: string,
  privilege: string,
) {
  if (
    !PRIVILEGES.includes(privilege as (typeof PRIVILEGES)[number]) ||
    !database ||
    !table ||
    driver === "sqlite"
  )
    throw new Error("Choose a database, table and supported privilege.");
  const target =
    table === "*"
      ? driver === "mysql"
        ? `${quoteIdentifier(database, driver)}.*`
        : `ALL TABLES IN SCHEMA ${quoteIdentifier(schema || "public", driver)}`
      : `${driver === "postgres" ? "TABLE " : ""}${qualifiedName({ name: table, schema: driver === "mysql" ? database : schema || "public", kind: "table" }, driver)}`;
  return `${action} ${privilege} ON ${target} ${action === "GRANT" ? "TO" : "FROM"} ${accountSql(driver, name, host)};`;
}
export function roleSql(
  driver: Driver,
  action: "create" | "grant" | "revoke",
  role: string,
  member: string,
  host: string,
) {
  if (driver === "sqlite" || !role.trim() || /[\0\\]/.test(role))
    throw new Error("Choose a valid server role.");
  const target = quoteIdentifier(role, driver);
  return action === "create"
    ? `CREATE ROLE ${target};`
    : `${action.toUpperCase()} ${target} ${action === "grant" ? "TO" : "FROM"} ${accountSql(driver, member, host)};`;
}
export function resultRecords(result: QueryResult) {
  return result.rows.map((row) =>
    Object.fromEntries(result.columns.map((name, i) => [name, row[i]])),
  );
}
export interface BuilderJoin {
  table: TableInfo;
  left: string;
  right: string;
  kind: "INNER" | "LEFT" | "RIGHT";
}
export interface BuilderDesign {
  tables: TableInfo[];
  joins: BuilderJoin[];
  selected: string[];
  sort?: string;
  descending?: boolean;
  limit: number;
}
export function builderColumns(
  tables: TableInfo[],
  columns: Record<string, string[]>,
) {
  return tables.flatMap((table, i) =>
    (columns[JSON.stringify([table.schema, table.name])] ?? []).map((name) => ({
      id: `${i}:${name}`,
      table: i,
      name,
    })),
  );
}
export function builderSql(
  driver: Driver,
  design: BuilderDesign,
  columns: Record<string, string[]>,
) {
  if (!design.tables.length) return "";
  if (
    !Number.isInteger(design.limit) ||
    design.limit < 1 ||
    design.limit > 50000
  )
    throw new Error("Limit must be between 1 and 50,000.");
  const all = builderColumns(design.tables, columns);
  const field = (id: string) => {
    const column = all.find((c) => c.id === id);
    if (!column) throw new Error("Select a valid join or output column.");
    return `t${column.table + 1}.${quoteIdentifier(column.name, driver)}`;
  };
  const selected = design.selected.length
    ? design.selected
        .map(
          (id) =>
            `${field(id)} AS ${quoteIdentifier(`t${all.find((c) => c.id === id)!.table + 1}_${all.find((c) => c.id === id)!.name}`, driver)}`,
        )
        .join(",\n  ")
    : "t1.*";
  const joins = design.tables.slice(1).map((table, i) => {
    const join = design.joins[i];
    if (!join || !["INNER", "LEFT", "RIGHT"].includes(join.kind))
      throw new Error("Configure a join for each additional table.");
    const left = all.find((c) => c.id === join.left),
      right = all.find((c) => c.id === join.right);
    if (!left || !right || left.table > i || right.table !== i + 1)
      throw new Error("Join an earlier table to the new table.");
    if (driver === "sqlite" && join.kind === "RIGHT")
      throw new Error("Use LEFT JOIN for SQLite compatibility.");
    return `${join.kind} JOIN ${qualifiedName(table, driver)} t${i + 2} ON ${field(join.left)} = ${field(join.right)}`;
  });
  return `SELECT\n  ${selected}\nFROM ${qualifiedName(design.tables[0], driver)} t1${joins.length ? "\n" + joins.join("\n") : ""}${design.sort ? "\nORDER BY " + field(design.sort) + (design.descending ? " DESC" : " ASC") : ""}\nLIMIT ${design.limit};`;
}
