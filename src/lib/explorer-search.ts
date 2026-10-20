import type { SchemaTree, TableInfo } from "../types";

export const searchTerm = (value: string) => value.trim().toLowerCase();
export function matchingTables(
  database: string,
  tables: TableInfo[],
  query: string,
): TableInfo[] {
  const term = searchTerm(query);
  return !term || database.toLowerCase().includes(term)
    ? tables
    : tables.filter((table) => table.name.toLowerCase().includes(term));
}
/** Bound metadata reads across unopened databases and share duplicate requests. */
export function createExplorerLoader(
  fetch: (connectionId: string, database: string) => Promise<SchemaTree>,
  concurrency = 3,
) {
  let running = 0;
  const queued: (() => Promise<void>)[] = [];
  const pending = new Map<string, Promise<SchemaTree>>();
  function pump() {
    while (running < concurrency && queued.length) {
      running++;
      void queued.shift()!().finally(() => {
        running--;
        pump();
      });
    }
  }
  return (connectionId: string, database: string) => {
    const key = JSON.stringify([connectionId, database]);
    const existing = pending.get(key);
    if (existing) return existing;
    const result = new Promise<SchemaTree>((resolve, reject) => {
      queued.push(async () => {
        try {
          resolve(await fetch(connectionId, database));
        } catch (cause) {
          reject(cause);
        } finally {
          pending.delete(key);
        }
      });
    });
    pending.set(key, result);
    pump();
    return result;
  };
}
