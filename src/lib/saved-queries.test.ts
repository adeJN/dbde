import { describe, expect, it } from "vitest";
import {
  duplicateSavedQuery,
  filterSavedQueries,
  migrateQueryFavorites,
  readSavedQueries,
  savedQueryNameError,
  tabHasUnsavedQuery,
  uniqueQueryName,
  type SavedQuery,
} from "./saved-queries";
import type { TabFavorite } from "./tab-actions";
import type { QueryTab } from "../types";

const query = (patch: Partial<SavedQuery> = {}): SavedQuery => ({
  id: "q1",
  profile_id: "p1",
  database: "app",
  name: "Orders",
  query: "SELECT * FROM orders",
  created_at: 1,
  updated_at: 1,
  ...patch,
});

describe("saved queries", () => {
  it("validates stored lists", () => {
    expect(
      readSavedQueries([
        query(),
        query(),
        { id: "x" },
        query({ id: "q2", description: 3 as never }),
      ]),
    ).toEqual([query()]);
    expect(readSavedQueries(null)).toEqual([]);
  });

  it("requires unique names per connection and database", () => {
    const list = [query()];
    expect(savedQueryNameError(" ", list, "p1", "app")).toBe("Enter a name.");
    expect(savedQueryNameError("orders", list, "p1", "app")).toMatch(
      /already exists/,
    );
    expect(savedQueryNameError("orders", list, "p1", "app", "q1")).toBe("");
    expect(savedQueryNameError("orders", list, "p1", "other")).toBe("");
    expect(savedQueryNameError("orders", list, "p2", "app")).toBe("");
    expect(uniqueQueryName("Orders", list, "p1", "app")).toBe("Orders 2");
    expect(uniqueQueryName("New", list, "p1", "app")).toBe("New");
  });

  it("duplicates with a fresh id and name", () => {
    const list = [query(), query({ id: "q2", name: "Orders copy" })];
    expect(duplicateSavedQuery(list[0], list, 9, "q3")).toEqual({
      ...list[0],
      id: "q3",
      name: "Orders copy 2",
      created_at: 9,
      updated_at: 9,
    });
  });

  it("marks only linked tabs whose SQL changed", () => {
    const tab: QueryTab = {
      id: "t",
      name: "Orders",
      connectionId: "c",
      query: "SELECT 1",
      running: false,
    };
    expect(tabHasUnsavedQuery(tab)).toBe(false);
    expect(
      tabHasUnsavedQuery({
        ...tab,
        savedQueryId: "q1",
        savedQuerySql: "SELECT 1",
      }),
    ).toBe(false);
    expect(
      tabHasUnsavedQuery({
        ...tab,
        savedQueryId: "q1",
        savedQuerySql: "SELECT 2",
      }),
    ).toBe(true);
  });

  it("migrates query favorites that are not saved yet, keeping their ids", () => {
    const favorites: TabFavorite[] = [
      {
        id: "f1",
        profile_id: "p1",
        database: "app",
        name: "Daily",
        kind: "query",
        query: "SELECT 2",
      },
      {
        id: "q1",
        profile_id: "p1",
        database: "app",
        name: "Orders",
        kind: "query",
        query: "SELECT 1",
      },
      {
        id: "t",
        profile_id: "p1",
        database: "app",
        name: "customers",
        kind: "table",
        query: "",
        table: { name: "customers", schema: "", kind: "table" },
      },
    ];
    expect(migrateQueryFavorites(favorites, [query()], 5)).toEqual([
      {
        id: "f1",
        profile_id: "p1",
        database: "app",
        name: "Daily",
        query: "SELECT 2",
        created_at: 5,
        updated_at: 5,
      },
    ]);
  });

  it("searches names, descriptions and SQL, sorted by name", () => {
    const list = [
      query({ id: "b", name: "Beta", description: "monthly report" }),
      query({ id: "a", name: "Alpha", query: "SELECT * FROM invoices" }),
    ];
    expect(filterSavedQueries(list, "").map((q) => q.id)).toEqual(["a", "b"]);
    expect(filterSavedQueries(list, "monthly").map((q) => q.id)).toEqual(["b"]);
    expect(filterSavedQueries(list, "invoices").map((q) => q.id)).toEqual([
      "a",
    ]);
  });
});
