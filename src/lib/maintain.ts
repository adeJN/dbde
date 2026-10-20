import type { Driver, TableInfo } from "../types";
import { qualifiedName, quoteIdentifier } from "./sql";

/** Table maintenance operations; the backend validates them per driver (maintain.rs). */
export type MaintainOperation =
  | "analyze"
  | "check"
  | "optimize"
  | "repair"
  | "vacuum"
  | "vacuum-analyze"
  | "vacuum-full"
  | "reindex"
  | "integrity-check"
  | "quick-check";
export interface MaintainInfo {
  operation: MaintainOperation;
  label: string;
  /** What the operation does, shown as the menu item's description. */
  hint: string;
  /**
   * Takes long or exclusive locks: confirm with the SQL first, and roll back the app's
   * own open transactions so it cannot wait on them.
   */
  locking: boolean;
  /** Runs on the whole database regardless of the selected tables (SQLite VACUUM). */
  databaseWide?: boolean;
  warning?: string;
}
export interface MaintainRow {
  table: string;
  op: string;
  msg_type: string;
  msg_text: string;
}
export interface MaintainResult {
  statements: string[];
  rows: MaintainRow[];
  execution_ms: number;
}
const OPERATIONS: Record<Driver, MaintainInfo[]> = {
  mysql: [
    {
      operation: "analyze",
      label: "Analyze",
      hint: "Refresh key distribution statistics",
      locking: false,
    },
    {
      operation: "check",
      label: "Check",
      hint: "Check tables for errors",
      locking: false,
    },
    {
      operation: "optimize",
      label: "Optimize",
      hint: "Reclaim space and defragment",
      locking: true,
      warning:
        "OPTIMIZE TABLE rebuilds each table (InnoDB recreates it and then analyzes it). Writes are blocked while it runs and large tables can take a long time.",
    },
    {
      operation: "repair",
      label: "Repair",
      hint: "MyISAM, Aria, ARCHIVE and CSV only",
      locking: true,
      warning:
        "REPAIR TABLE locks each table while it rebuilds it. It works only on MyISAM, Aria, ARCHIVE and CSV tables. Back up the table first: a repair can lose rows it cannot read.",
    },
  ],
  postgres: [
    {
      operation: "analyze",
      label: "Analyze",
      hint: "Refresh planner statistics",
      locking: false,
    },
    {
      operation: "vacuum",
      label: "Vacuum",
      hint: "Reclaim dead rows without locking",
      locking: false,
    },
    {
      operation: "vacuum-analyze",
      label: "Vacuum Analyze",
      hint: "Vacuum, then refresh statistics",
      locking: false,
    },
    {
      operation: "vacuum-full",
      label: "Vacuum Full",
      hint: "Rewrite the table; exclusive lock",
      locking: true,
      warning:
        "VACUUM FULL takes an ACCESS EXCLUSIVE lock and rewrites each table into a new file: every read and write on it waits until it finishes, and it needs free disk space for a full copy.",
    },
    {
      operation: "reindex",
      label: "Reindex",
      hint: "Rebuild every index of the table",
      locking: true,
      warning:
        "REINDEX TABLE rebuilds all indexes of each table. It blocks writes to the table and locks each index against reads while it is rebuilt.",
    },
  ],
  sqlite: [
    {
      operation: "analyze",
      label: "Analyze",
      hint: "Refresh query planner statistics",
      locking: false,
    },
    {
      operation: "integrity-check",
      label: "Integrity Check",
      hint: "PRAGMA integrity_check for the table",
      locking: false,
    },
    {
      operation: "quick-check",
      label: "Quick Check",
      hint: "Faster check without index contents",
      locking: false,
    },
    {
      operation: "reindex",
      label: "Reindex",
      hint: "Rebuild the table's indexes",
      locking: true,
      warning:
        "REINDEX rebuilds the indexes of each table and holds a write lock on the database while it runs.",
    },
    {
      operation: "vacuum",
      label: "Vacuum Database",
      hint: "Rebuild the whole database file",
      locking: true,
      databaseWide: true,
      warning:
        "SQLite VACUUM rebuilds the entire database file, not only the selected tables. It needs free disk space up to the file's size and locks the database until it finishes.",
    },
  ],
};
export function maintainOperations(driver: Driver): MaintainInfo[] {
  return OPERATIONS[driver];
}
export function maintainInfo(
  operation: MaintainOperation,
  driver: Driver,
): MaintainInfo | undefined {
  return OPERATIONS[driver].find((item) => item.operation === operation);
}
/** Engines that implement MySQL REPAIR TABLE. Unknown engines are left to the server. */
export function repairableEngine(engine?: string | null): boolean {
  return (
    !engine ||
    ["myisam", "aria", "archive", "csv"].includes(engine.toLowerCase())
  );
}
/** The statements the backend runs (mirrors maintain_sql in maintain.rs). */
export function maintainSql(
  operation: MaintainOperation,
  driver: Driver,
  tables: TableInfo[],
): string[] {
  const info = maintainInfo(operation, driver);
  if (!info)
    throw new Error(`${operation} is not available for this database.`);
  if (info.databaseWide) return ["VACUUM"];
  if (!tables.length) throw new Error("Choose at least one table.");
  if (tables.some((table) => table.kind !== "table"))
    throw new Error("Maintenance applies to tables only; views were selected.");
  const names = tables.map((table) => qualifiedName(table, driver));
  if (driver === "mysql")
    return [`${operation.toUpperCase()} TABLE ${names.join(", ")}`];
  if (driver === "postgres") {
    const verb = {
      analyze: "ANALYZE",
      vacuum: "VACUUM",
      "vacuum-analyze": "VACUUM ANALYZE",
      "vacuum-full": "VACUUM FULL",
      reindex: "REINDEX TABLE",
    }[operation as "analyze"];
    return names.map((name) => `${verb} ${name}`);
  }
  return tables.map((table) => {
    const schema = table.schema
      ? `${quoteIdentifier(table.schema, driver)}.`
      : "";
    const name = quoteIdentifier(table.name, driver);
    if (operation === "integrity-check")
      return `PRAGMA ${schema}integrity_check(${name})`;
    if (operation === "quick-check")
      return `PRAGMA ${schema}quick_check(${name})`;
    return `${operation.toUpperCase()} ${schema}${name}`;
  });
}
/** Rows as tab-separated text for Copy. */
export function maintainText(result: MaintainResult): string {
  return [
    "Table\tOp\tMsg_type\tMsg_text",
    ...result.rows.map((row) =>
      [row.table, row.op, row.msg_type, row.msg_text].join("\t"),
    ),
  ].join("\n");
}
