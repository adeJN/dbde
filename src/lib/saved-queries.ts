/**
 * Saved queries (Navicat's "Queries" objects): named SQL kept per connection
 * profile and database. Query favorites are pins to saved queries: a favorite of
 * kind "query" shares its id with the saved query it opens.
 */
import type { QueryTab } from "../types";
import type { TabFavorite } from "./tab-actions";

export interface SavedQuery {
  id: string;
  profile_id: string;
  database: string;
  name: string;
  description?: string;
  query: string;
  created_at: number;
  updated_at: number;
}
export const MAX_SAVED_QUERY_BYTES = 1024 * 1024;
export const QUERY_FAVORITES_MIGRATED_KEY = "dbde.query-favorites-migrated";

export function isSavedQuery(value: unknown): value is SavedQuery {
  const item = value as SavedQuery;
  return (
    !!item &&
    typeof item === "object" &&
    typeof item.id === "string" &&
    typeof item.profile_id === "string" &&
    typeof item.database === "string" &&
    typeof item.name === "string" &&
    typeof item.query === "string" &&
    typeof item.created_at === "number" &&
    typeof item.updated_at === "number" &&
    (item.description === undefined || typeof item.description === "string")
  );
}
export function readSavedQueries(list: unknown): SavedQuery[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list.filter((value): value is SavedQuery => {
    if (!isSavedQuery(value) || seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}

export function savedQueryNameError(
  name: string,
  others: SavedQuery[],
  profileId: string,
  database: string,
  id?: string,
) {
  const trimmed = name.trim();
  if (!trimmed) return "Enter a name.";
  if (trimmed.length > 200) return "Use at most 200 characters.";
  if (
    others.some(
      (other) =>
        other.id !== id &&
        other.profile_id === profileId &&
        other.database === database &&
        other.name.toLowerCase() === trimmed.toLowerCase(),
    )
  )
    return "A saved query with this name already exists in this database.";
  return "";
}

/** A name not used yet in the database, e.g. "Orders copy 2". */
export function uniqueQueryName(
  base: string,
  others: SavedQuery[],
  profileId: string,
  database: string,
) {
  const taken = new Set(
    others
      .filter((q) => q.profile_id === profileId && q.database === database)
      .map((q) => q.name.toLowerCase()),
  );
  if (!taken.has(base.toLowerCase())) return base;
  for (let n = 2; ; n++) {
    const name = `${base} ${n}`;
    if (!taken.has(name.toLowerCase())) return name;
  }
}

export function duplicateSavedQuery(
  query: SavedQuery,
  others: SavedQuery[],
  now: number,
  id: string = crypto.randomUUID(),
): SavedQuery {
  return {
    ...query,
    id,
    name: uniqueQueryName(
      `${query.name} copy`,
      others,
      query.profile_id,
      query.database,
    ),
    created_at: now,
    updated_at: now,
  };
}

/** True when the tab edits a saved query and its SQL differs from what was saved. */
export function tabHasUnsavedQuery(tab: QueryTab) {
  return (
    !!tab.savedQueryId &&
    tab.savedQuerySql !== undefined &&
    tab.query !== tab.savedQuerySql
  );
}

/** Query favorites saved before saved queries existed become saved queries. */
export function migrateQueryFavorites(
  favorites: TabFavorite[],
  saved: SavedQuery[],
  now: number,
): SavedQuery[] {
  const known = new Set(saved.map((query) => query.id));
  return favorites
    .filter((favorite) => favorite.kind === "query" && !known.has(favorite.id))
    .map((favorite) => ({
      id: favorite.id,
      profile_id: favorite.profile_id,
      database: favorite.database,
      name: favorite.name,
      query: favorite.query,
      created_at: now,
      updated_at: now,
    }));
}

export function filterSavedQueries(queries: SavedQuery[], text: string) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return queries
    .filter((query) =>
      words.every((word) =>
        `${query.name}\n${query.description ?? ""}\n${query.database}\n${query.query}`
          .toLowerCase()
          .includes(word),
      ),
    )
    .sort((a, b) => a.name.localeCompare(b.name));
}
