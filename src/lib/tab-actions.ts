import type { QueryTab, Session, TableInfo } from "../types";
export interface TabFavorite {
  id: string;
  profile_id: string;
  database: string;
  name: string;
  kind: "database" | "table" | "query";
  query: string;
  table?: TableInfo;
}
export function favoriteFor(tab: QueryTab, session: Session): TabFavorite {
  const table =
    tab.result?.source?.table ??
    (tab.tableIdentity
      ? {
          name: tab.tableIdentity.name,
          schema: tab.tableIdentity.schema,
          kind: "table",
        }
      : undefined);
  const kind = tab.kind === "database" ? "database" : table ? "table" : "query";
  const database = tab.database ?? session.config.database;
  return {
    id:
      kind === "query"
        ? (tab.savedQueryId ?? tab.favoriteId ?? tab.id)
        : JSON.stringify([
            session.config.id,
            kind,
            database,
            table?.schema,
            table?.name,
          ]),
    profile_id: session.config.id,
    database,
    name: tab.name,
    kind,
    query: tab.query,
    table,
  };
}
export function readTabFavorites(raw: string | null): TabFavorite[] {
  try {
    const list = JSON.parse(raw ?? "[]");
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (item): item is TabFavorite =>
          item &&
          typeof item.id === "string" &&
          typeof item.profile_id === "string" &&
          typeof item.database === "string" &&
          typeof item.name === "string" &&
          typeof item.query === "string" &&
          ["database", "table", "query"].includes(item.kind) &&
          (item.kind !== "table" ||
            (typeof item.table?.name === "string" &&
              typeof item.table?.schema === "string" &&
              typeof item.table?.kind === "string")),
      )
      .slice(0, 100);
  } catch {
    return [];
  }
}
export function tabsToClose(
  tabs: QueryTab[],
  id: string,
  action: "close" | "others" | "right" | "all",
) {
  const index = tabs.findIndex((tab) => tab.id === id);
  if (index < 0) return [];
  return tabs.filter(
    (tab, position) =>
      action === "all" ||
      (action === "close"
        ? tab.id === id
        : action === "others"
          ? tab.id !== id
          : position > index),
  );
}
