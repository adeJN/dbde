import type { Driver, TableInfo, TableFilter, TableSort } from "../types";
export function tableFilterClause(
  filters: TableFilter[],
  driver: Driver,
  inline = false,
): { sql: string; values: string[] } {
  if (filters.length > 10) throw new Error("Use at most 10 filter conditions.");
  const values: string[] = [];
  const conditions = filters.map((filter) => {
    if (
      (filter.join != null && !["and", "or"].includes(filter.join)) ||
      !filter.column ||
      typeof filter.value !== "string" ||
      new TextEncoder().encode(filter.value).length > 10000
    )
      throw new Error("Invalid filter column or value.");
    const column = quoteIdentifier(filter.column, driver);
    if (filter.operator === "is_null") return `${column} IS NULL`;
    if (filter.operator === "is_not_null") return `${column} IS NOT NULL`;
    const escaped = filter.value
      .replaceAll("!", "!!")
      .replaceAll("%", "!%")
      .replaceAll("_", "!_");
    const operators = {
      equals: ["=", filter.value, ""],
      not_equals: ["<>", filter.value, ""],
      contains: ["LIKE", `%${escaped}%`, " ESCAPE '!'"],
      not_contains: ["NOT LIKE", `%${escaped}%`, " ESCAPE '!'"],
      starts_with: ["LIKE", `${escaped}%`, " ESCAPE '!'"],
      ends_with: ["LIKE", `%${escaped}`, " ESCAPE '!'"],
    };
    const entry = operators[filter.operator];
    if (!entry) throw new Error("Unsupported filter operator.");
    const [operator, value, suffix] = entry;
    values.push(value);
    let placeholder = driver === "postgres" ? `$${values.length}` : "?";
    if (inline) {
      const hex = Array.from(new TextEncoder().encode(value), (byte) =>
        byte.toString(16).padStart(2, "0"),
      ).join("");
      placeholder =
        driver === "mysql"
          ? hex
            ? `CONVERT(0x${hex} USING utf8mb4)`
            : "''"
          : driver === "postgres"
            ? `convert_from(decode('${hex}', 'hex'), 'UTF8')`
            : `CAST(X'${hex}' AS TEXT)`;
    }
    return `CAST(${column} AS ${driver === "mysql" ? "CHAR" : "TEXT"}) ${operator} ${placeholder}${suffix}`;
  });
  return {
    sql: conditions.length
      ? " WHERE " +
        conditions
          .map(
            (condition, index) =>
              `${index ? (filters[index].join === "or" ? " OR " : " AND ") : ""}${condition}`,
          )
          .join("")
      : "",
    values,
  };
}
export function quoteIdentifier(value: string, driver: Driver) {
  const quote = driver === "mysql" ? "`" : '"';
  return quote + value.replaceAll(quote, quote + quote) + quote;
}
export function tableQuery(
  table: TableInfo,
  driver: Driver,
  pageSize = 1000,
  page = 1,
  orderKeys: string[] = [],
  filters: TableFilter[] = [],
  sort?: TableSort,
) {
  if (
    !Number.isSafeInteger(pageSize) ||
    pageSize < 1 ||
    pageSize > 5000 ||
    !Number.isSafeInteger(page) ||
    page < 1 ||
    !Number.isSafeInteger((page - 1) * pageSize)
  )
    throw new Error("Invalid page or page size.");
  const orderParts = [
    ...(sort
      ? [
          `${quoteIdentifier(sort.column, driver)} ${sort.direction.toUpperCase()}`,
        ]
      : []),
    ...orderKeys
      .filter((key) => key !== sort?.column)
      .map((key) => quoteIdentifier(key, driver)),
  ];
  const order = orderParts.length ? `\nORDER BY ${orderParts.join(", ")}` : "";
  return `SELECT * FROM ${qualifiedName(table, driver)}${tableFilterClause(filters, driver, true).sql}${order}\nLIMIT ${pageSize}${page > 1 ? ` OFFSET ${(page - 1) * pageSize}` : ""};`;
}
export function displayValue(value: unknown): string {
  if (value && typeof value === "object" && "deferred" in value)
    return "BLOB · double-click to load";
  return value == null
    ? "NULL"
    : typeof value === "object"
      ? JSON.stringify(value)
      : String(value);
}
// Plain numbers such as -12.50 or +62 stay intact; other leading formula characters are
// neutralised so spreadsheets do not evaluate exported or pasted text.
export function spreadsheetText(value: unknown): string {
  const text = value == null ? "" : displayValue(value);
  return /^[=+\-@\t\r]/.test(text) &&
    !/^[+-]?\d+(\.\d+)?([eE][+-]?\d+)?$/.test(text)
    ? "'" + text
    : text;
}
export function csvCell(value: unknown): string {
  return '"' + spreadsheetText(value).replaceAll('"', '""') + '"';
}
// Blanks out comments, string literals and quoted identifiers so keyword checks only see
// SQL structure. Lengths are irrelevant; only statement boundaries and keywords matter.
// MySQL also has # comments and backslash escapes in strings; PostgreSQL has dollar quotes.
export const SQL_TOKENS = {
  mysql:
    /--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^'\\]|\\.|'')*'|"(?:[^"\\]|\\.|"")*"|`(?:[^`]|``)*`/g,
  postgres:
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|\$([A-Za-z_]\w*)?\$[\s\S]*?\$\1\$/g,
  sqlite:
    /--[^\n]*|\/\*[\s\S]*?\*\/|'(?:[^']|'')*'|"(?:[^"]|"")*"|`(?:[^`]|``)*`|\[[^\]]*\]/g,
};
function sqlSkeleton(sql: string, driver: Driver): string {
  return sql.replace(SQL_TOKENS[driver], (token) =>
    /^(--|#|\/\*)/.test(token) ? " " : "''",
  );
}
/** Statements that drop or wipe data without a filter, for a confirmation prompt. */
function destructiveSkeleton(statement: string, nesting = 0): boolean {
  // WHERE in a CTE/subquery does not constrain the outer write. Inspect each
  // scope separately, including PostgreSQL data-modifying CTE bodies.
  if (nesting > 100) return true;
  let top = "";
  let depth = 0;
  let start = 0;
  for (let index = 0; index < statement.length; index++) {
    const char = statement[index];
    if (char === "(") {
      if (depth++ === 0) {
        start = index + 1;
        top += " () ";
      }
    } else if (char === ")" && depth > 0) {
      if (
        --depth === 0 &&
        destructiveSkeleton(statement.slice(start, index), nesting + 1)
      )
        return true;
    } else if (depth === 0) top += char;
  }
  top = top.trim();
  if (/^WITH\b/i.test(top)) {
    const main = /\b(SELECT|INSERT|UPDATE|DELETE|MERGE)\b/i.exec(top);
    top = main ? top.slice(main.index) : top;
  }
  return (
    /^(DROP|TRUNCATE)\b/i.test(top) ||
    (/^(DELETE|UPDATE)\b/i.test(top) && !/\bWHERE\b/i.test(top)) ||
    /^ALTER\s+TABLE\b.*\bDROP\b/i.test(top)
  );
}
export function destructiveStatements(sql: string, driver: Driver): string[] {
  return sqlSkeleton(sql, driver)
    .split(";")
    .map((statement) => statement.trim().replace(/\s+/g, " "))
    .filter((statement) => destructiveSkeleton(statement))
    .map((statement) =>
      statement.length > 160 ? statement.slice(0, 157) + "…" : statement,
    );
}
export function qualifiedName(table: TableInfo, driver: Driver) {
  return `${table.schema ? quoteIdentifier(table.schema, driver) + "." : ""}${quoteIdentifier(table.name, driver)}`;
}
/** Quotes only when the bare name would not resolve to the same identifier. */
export function completionIdentifier(name: string, driver: Driver) {
  const bare =
    driver === "postgres" ? /^[a-z_][a-z0-9_]*$/ : /^[A-Za-z_][A-Za-z0-9_]*$/;
  return bare.test(name) ? name : quoteIdentifier(name, driver);
}
/** Why a new table name cannot be used, or "" when it can (mirrors the backend). */
export function tableNameError(
  table: TableInfo,
  name: string,
  driver: Driver,
  existing: TableInfo[] = [],
) {
  if (!name.trim()) return "Enter a name.";
  if (name.trim() !== name) return "Remove leading and trailing spaces.";
  if (name.includes("\0")) return "The name contains an invalid character.";
  if (name === table.name) return "Enter a different name.";
  if (driver === "postgres" && new TextEncoder().encode(name).length > 63)
    return "PostgreSQL names are limited to 63 bytes.";
  if (driver === "mysql" && Array.from(name).length > 64)
    return "MySQL table names are limited to 64 characters.";
  if (driver === "sqlite" && Array.from(name).length > 128)
    return "Use a name of at most 128 characters.";
  if (driver === "sqlite" && table.kind === "view")
    return "SQLite cannot rename a view. Recreate it with the new name instead.";
  // MySQL on case-insensitive file systems and SQLite compare names without case.
  const same = (other: string) =>
    driver === "postgres"
      ? other === name
      : other.toLowerCase() === name.toLowerCase();
  if (
    existing.some(
      (other) =>
        other.schema === table.schema &&
        other.name !== table.name &&
        same(other.name),
    )
  )
    return `A table or view named "${name}" already exists.`;
  return "";
}
/** The statement DBde runs to rename a table or view (shown as a preview). */
export function renameTableSql(table: TableInfo, name: string, driver: Driver) {
  const source = qualifiedName(table, driver);
  if (driver === "mysql")
    return `RENAME TABLE ${source} TO ${qualifiedName({ ...table, name }, driver)};`;
  if (driver === "postgres")
    return `ALTER ${table.kind === "view" ? "VIEW" : "TABLE"} ${source} RENAME TO ${quoteIdentifier(name, driver)};`;
  return `ALTER TABLE ${source} RENAME TO ${quoteIdentifier(name, driver)};`;
}
export function tableActionSql(
  action: "truncate" | "empty" | "drop",
  table: TableInfo,
  driver: Driver,
) {
  const target = qualifiedName(table, driver);
  if (action === "drop")
    return `DROP ${table.kind === "view" ? "VIEW" : "TABLE"} ${target};`;
  if (action === "empty") return `DELETE FROM ${target};`;
  // SQLite has no TRUNCATE; an unfiltered DELETE is its truncate optimisation.
  return driver === "sqlite"
    ? `DELETE FROM ${target};`
    : `TRUNCATE TABLE ${target}${driver === "postgres" ? " RESTART IDENTITY" : ""};`;
}
