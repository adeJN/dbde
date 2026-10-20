import * as api from "./api";
import { qualifiedName, quoteIdentifier } from "./sql";
import { sqlLiteral, insertStatements } from "./grid";
import type { ColumnMapping, Driver, QueryResult, TableInfo } from "../types";

/** Never use the paginated grid's filters or estimated row count for a whole-table operation. */
export async function readTable(
  connectionId: string,
  database: string,
  table: TableInfo,
  driver: Driver,
  limit: number,
): Promise<QueryResult> {
  const target = qualifiedName(table, driver);
  const count = await api.execute(
    connectionId,
    `SELECT COUNT(*) AS row_count FROM ${target}`,
    database,
  );
  const total = Number(count.rows[0]?.[0]);
  if (!Number.isSafeInteger(total) || total < 0 || total > limit)
    throw new Error(
      `This operation supports up to ${limit.toLocaleString()} records. Narrow the source using SQL for larger transfers.`,
    );
  const columns = await api.exportColumns(connectionId, database, table);
  if (!columns.length) throw new Error("No writable columns found.");
  const metadata = await api.viewTable(connectionId, database, table, 1, 1);
  const keys = metadata.source?.primary_keys ?? [];
  const order = keys.length
    ? ` ORDER BY ${keys.map((name) => quoteIdentifier(name, driver)).join(", ")}`
    : "";
  if (!keys.length && total > 5000)
    throw new Error(
      "Whole-table exports over 5,000 records require a primary key for stable pagination.",
    );
  const batchSize = total <= 5000 ? 5001 : 1000;
  const rows: unknown[][] = [];
  // Read one extra row to detect a table that grew after counting.
  for (let offset = 0; offset <= total; offset += batchSize) {
    const page = await api.execute(
      connectionId,
      `SELECT ${columns.map((n) => quoteIdentifier(n, driver)).join(", ")} FROM ${target}${order} LIMIT ${batchSize} OFFSET ${offset}`,
      database,
    );
    rows.push(
      ...page.rows.map((row) =>
        row.map((value) =>
          value instanceof Uint8Array
            ? {
                hex: Array.from(value, (byte) =>
                  byte.toString(16).padStart(2, "0"),
                ).join(""),
              }
            : value,
        ),
      ),
    );
    if (rows.length > limit)
      throw new Error(
        "The table grew beyond the operation limit. Nothing was transferred.",
      );
    if (page.rows.length < batchSize) break;
  }
  if (rows.length !== total)
    throw new Error(
      "The table changed while being read. Retry when writes have stopped.",
    );
  return { columns, rows, affected_rows: 0, execution_ms: 0, truncated: false };
}
export function mappedRecords(result: QueryResult, mapping: ColumnMapping[]) {
  if (
    !mapping.length ||
    new Set(mapping.map((m) => m.target)).size !== mapping.length
  )
    throw new Error("Choose at least one unique target column.");
  if (mapping.some((m) => !result.columns.includes(m.source) || !m.target))
    throw new Error("Invalid column mapping.");
  return result.rows.map((row) => ({
    kind: "insert" as const,
    values: Object.fromEntries(
      mapping.map((m) => {
        const value = row[result.columns.indexOf(m.source)];
        if (value !== null && typeof value === "object")
          throw new Error(
            "Binary values require a SQL dump; this transfer supports scalar values only.",
          );
        return [
          m.target,
          value == null
            ? null
            : typeof value === "boolean"
              ? value
                ? "1"
                : "0"
              : String(value),
        ];
      }),
    ),
  }));
}
export async function dumpTable(
  connectionId: string,
  database: string,
  table: TableInfo,
  driver: Driver,
  data: boolean,
  includeDdl = true,
) {
  let contents = includeDdl
    ? await api.tableDdl(connectionId, table, database)
    : "";
  if (data) {
    const result = await readTable(
      connectionId,
      database,
      table,
      driver,
      100_000,
    );
    const inserts = result.rows
      .map((row) => {
        const statement = insertStatements(table, driver, result.columns, [
          row,
        ]);
        return driver === "postgres"
          ? statement.replace(
              ") VALUES (",
              ") OVERRIDING SYSTEM VALUE VALUES (",
            )
          : statement;
      })
      .join("\n");
    contents += "\n\n" + inserts;
    if (driver === "postgres" && result.rows.length) {
      const target = qualifiedName(table, driver);
      const body = `DECLARE c record; v bigint; BEGIN FOR c IN SELECT a.attname AS name, pg_get_serial_sequence(${sqlLiteral(target, driver)}, a.attname) AS seq FROM pg_attribute a WHERE a.attrelid = ${sqlLiteral(target, driver)}::regclass AND a.attnum > 0 AND NOT a.attisdropped LOOP IF c.seq IS NOT NULL THEN EXECUTE format('SELECT MAX(%I)::bigint FROM %s', c.name, ${sqlLiteral(target, driver)}) INTO v; IF v IS NOT NULL THEN PERFORM setval(c.seq::regclass, GREATEST(v, 1), true); END IF; END IF; END LOOP; END`;
      let delimiter = "$dbde_reset$";
      while (body.includes(delimiter))
        delimiter = delimiter.slice(0, -1) + "_" + "$";
      contents += `\n\nDO ${delimiter} ${body} ${delimiter};`;
    }
  }
  if (new Blob([contents]).size > 512 * 1024 * 1024)
    throw new Error("The dump exceeds 512 MB.");
  return contents + "\n";
}
