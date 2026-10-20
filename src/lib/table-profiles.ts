import type { TableFilter, TableSort } from "../types";
import type { GridLayout } from "./grid-layout";
export interface TableProfile {
  id: string;
  name: string;
  filters: TableFilter[];
  sort?: TableSort;
  layout: GridLayout;
}
export const tableProfilesKey = (layoutKey: string) => `${layoutKey}:profiles`;
export function readTableProfiles(key: string): TableProfile[] {
  try {
    const list = JSON.parse(
      localStorage.getItem(tableProfilesKey(key)) ?? "[]",
    );
    if (!Array.isArray(list)) return [];
    return list
      .filter(
        (p): p is TableProfile =>
          typeof p?.id === "string" &&
          typeof p.name === "string" &&
          p.name.length <= 80 &&
          Array.isArray(p.filters) &&
          p.filters.length <= 10 &&
          p.filters.every(
            (f: TableFilter) =>
              typeof f?.column === "string" &&
              typeof f.value === "string" &&
              [
                "equals",
                "not_equals",
                "contains",
                "not_contains",
                "starts_with",
                "ends_with",
                "is_null",
                "is_not_null",
              ].includes(f.operator) &&
              (f.join === undefined || f.join === "and" || f.join === "or"),
          ) &&
          (!p.sort ||
            (typeof p.sort.column === "string" &&
              ["asc", "desc"].includes(p.sort.direction))) &&
          Array.isArray(p.layout?.hidden) &&
          p.layout.hidden.every((v: unknown) => typeof v === "string") &&
          Array.isArray(p.layout.frozen) &&
          p.layout.frozen.every((v: unknown) => typeof v === "string"),
      )
      .slice(0, 30);
  } catch {
    return [];
  }
}
export function saveTableProfiles(key: string, profiles: TableProfile[]) {
  if (profiles.length > 30)
    throw new Error("Use at most 30 profiles per table.");
  localStorage.setItem(tableProfilesKey(key), JSON.stringify(profiles));
}
export function checkedProfile(
  profile: TableProfile,
  columns: string[],
): TableProfile {
  const known = new Set(columns);
  if (
    profile.filters.some((f) => !known.has(f.column)) ||
    (profile.sort && !known.has(profile.sort.column))
  )
    throw new Error(
      "A filter/sort column no longer exists. Edit or recreate this profile.",
    );
  return {
    ...profile,
    layout: {
      hidden: profile.layout.hidden.filter((c) => known.has(c)),
      frozen: profile.layout.frozen.filter((c) => known.has(c)),
    },
  };
}
