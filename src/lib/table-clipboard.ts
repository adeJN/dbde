import type { Driver, TableInfo } from "../types";
export interface TableClipboard {
  connectionId: string;
  database: string;
  tables: TableInfo[];
  text: string;
}
export function tableKey(table: TableInfo): string {
  return JSON.stringify([table.schema, table.name]);
}
export function suggestTableName(
  name: string,
  existing: Set<string>,
  driver: Driver,
): string {
  const limit = driver === "mysql" ? 64 : driver === "postgres" ? 63 : 128;
  const fit = (value: string, bytes: number) => {
    const chars = [...value];
    while (new TextEncoder().encode(chars.join("")).length > bytes) chars.pop();
    return chars.join("");
  };
  const occupied = (value: string) =>
    driver === "mysql"
      ? [...existing].some((item) => item.toLowerCase() === value.toLowerCase())
      : existing.has(value);
  const original = fit(name, limit);
  if (!occupied(original)) return original;
  for (let number = 1; number < 10000; number++) {
    const suffix = number === 1 ? "_copy" : `_copy${number}`;
    const candidate = fit(name, limit - suffix.length) + suffix;
    if (!occupied(candidate)) return candidate;
  }
  throw new Error("Choose a unique target table name.");
}
