import * as api from "./api";
import { dumpTable } from "./table-tools";
import { quoteIdentifier } from "./sql";
import type { ConnectionConfig, Session } from "../types";
export function sharedDatabaseProfile(
  config: ConnectionConfig,
  database: string,
) {
  return JSON.stringify(
    {
      format: "dbde-connection",
      version: 1,
      connection: {
        name: config.name,
        driver: config.driver,
        host: config.host,
        port: config.port,
        username: config.username,
        database,
        ...(config.database_only ? { database_only: true } : {}),
        ssl_mode: config.ssl_mode,
        file_path: config.file_path,
      },
    },
    null,
    2,
  );
}
export const databaseFileName = (name: string, extension: string) =>
  `${name.replace(/[\\/\u0000-\u001f]/g, "_").slice(0, 180)}.${extension}`;
export async function dumpDatabase(
  session: Session,
  database: string,
  data: boolean,
): Promise<string> {
  const { driver } = session.config;
  const tree = await api.schema(session.id, database);
  if (tree.tables.length > 200)
    throw new Error(
      "This dump supports up to 200 tables/views. Export larger databases with the server's backup tools.",
    );
  const parts = [
    "-- DBde SQL export. Review dependencies, custom types and permissions before restoring.",
  ];
  const after: string[] = [];
  const views = tree.tables.filter((t) => t.kind === "view");
  if (driver === "mysql")
    parts.push(
      `SET @DBDE_PREVIOUS_FK_CHECKS = @@FOREIGN_KEY_CHECKS;\nSET FOREIGN_KEY_CHECKS = 0;\nUSE ${quoteIdentifier(database, driver)};`,
    );
  if (driver === "sqlite") {
    const schema = await api.execute(
      session.id,
      "SELECT type, sql FROM sqlite_master WHERE sql IS NOT NULL AND name NOT LIKE 'sqlite_%' ORDER BY type = 'table' DESC, name",
      database,
    );
    if (schema.truncated) throw new Error("Schema exceeds the export limit.");
    parts.push("PRAGMA foreign_keys = OFF;");
    for (const [type, sql] of schema.rows)
      if (type === "table" || type === "index") parts.push(String(sql) + ";");
      else after.push(String(sql) + ";");
  } else {
    if (driver === "postgres") {
      for (const schema of new Set(
        tree.tables.map((t) => t.schema).filter(Boolean),
      ))
        parts.push(
          `CREATE SCHEMA IF NOT EXISTS ${quoteIdentifier(schema, driver)};`,
        );
    }
    for (const table of tree.tables.filter((t) => t.kind !== "view"))
      parts.push(
        await api.tableDdl(session.id, table, database, driver === "postgres"),
      );
    for (const view of views)
      after.push(await api.tableDdl(session.id, view, database));
  }
  if (data)
    for (const table of tree.tables.filter((t) => t.kind === "table")) {
      parts.push(
        await dumpTable(session.id, database, table, driver, true, false),
      );
      if (new Blob(parts).size > 512 * 1024 * 1024)
        throw new Error("The dump exceeds 512 MB.");
    }
  if (driver === "postgres") {
    const constraints = await api.execute(
      session.id,
      "SELECT n.nspname, t.relname, 'ALTER TABLE ' || quote_ident(n.nspname) || '.' || quote_ident(t.relname) || ' ADD CONSTRAINT ' || quote_ident(c.conname) || ' ' || pg_get_constraintdef(c.oid) || ';' FROM pg_constraint c JOIN pg_class t ON t.oid = c.conrelid JOIN pg_namespace n ON n.oid = t.relnamespace WHERE c.contype = 'f'",
      database,
    );
    if (constraints.truncated)
      throw new Error("Foreign key metadata exceeds the export limit.");
    const selected = new Set(
      tree.tables.map((t) => JSON.stringify([t.schema, t.name])),
    );
    for (const [schema, name, sql] of constraints.rows)
      if (selected.has(JSON.stringify([schema, name])))
        after.unshift(String(sql));
  }
  parts.push(...after);
  if (driver === "mysql")
    parts.push("SET FOREIGN_KEY_CHECKS = @DBDE_PREVIOUS_FK_CHECKS;");
  if (driver === "sqlite") parts.push("PRAGMA foreign_keys = ON;");
  if (new Blob(parts).size > 512 * 1024 * 1024)
    throw new Error("The dump exceeds 512 MB.");
  return parts.join("\n\n") + "\n";
}
