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
    sql: conditions.length ? " WHERE " + conditions.join(" AND ") : "",
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
  return `SELECT * FROM ${table.schema ? quoteIdentifier(table.schema, driver) + "." : ""}${quoteIdentifier(table.name, driver)}${tableFilterClause(filters, driver, true).sql}${order}\nLIMIT ${pageSize}${page > 1 ? ` OFFSET ${(page - 1) * pageSize}` : ""};`;
}
export function displayValue(value: unknown): string {
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
