import type { ColumnInfo, TableInfo } from "../types";

/** Metadata is valid for one schema snapshot; replaced trees release their cache. */
export function createColumnCache(
  load: (
    connectionId: string,
    table: TableInfo,
    database?: string,
  ) => Promise<ColumnInfo[]>,
) {
  const snapshots = new WeakMap<
    readonly TableInfo[],
    Map<string, Promise<ColumnInfo[]>>
  >();
  return (
    tables: readonly TableInfo[],
    connectionId: string,
    database: string | undefined,
    table: TableInfo,
  ) => {
    let cache = snapshots.get(tables);
    if (!cache) {
      cache = new Map();
      snapshots.set(tables, cache);
    }
    const key = JSON.stringify([
      connectionId,
      database,
      table.schema,
      table.name,
    ]);
    const hit = cache.get(key);
    if (hit) return hit;
    const entries = cache;
    const pending = Promise.resolve()
      .then(() => load(connectionId, table, database))
      .catch((error) => {
        if (entries.get(key) === pending) entries.delete(key);
        throw error;
      });
    entries.set(key, pending);
    return pending;
  };
}
