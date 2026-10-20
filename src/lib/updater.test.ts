import { expect, it } from "vitest";
import { updateBlocker } from "./updater";
import { emptyStaged } from "./staged";
import type { QueryTab } from "../types";
const tab = (patch: Partial<QueryTab>): QueryTab => ({
  id: "1",
  name: "Query",
  connectionId: "c",
  query: "",
  running: false,
  ...patch,
});
it("protects SQL, table edits, transactions and running queries before restart", () => {
  expect(updateBlocker([tab({ running: true })], 0)).toMatch(/running queries/);
  expect(updateBlocker([tab({ query: "SELECT 1" })], 0)).toMatch(
    /Save your SQL/,
  );
  expect(
    updateBlocker([tab({ query: "SELECT 1", savedQuerySql: "SELECT 1" })], 0),
  ).toBeNull();
  expect(
    updateBlocker(
      [tab({ staged: { ...emptyStaged(), transaction: true } })],
      0,
    ),
  ).toMatch(/transactions/);
  expect(
    updateBlocker(
      [
        tab({
          staged: {
            ...emptyStaged(),
            drafts: [{ key: "new", values: { name: "Ada" } }],
          },
        }),
      ],
      0,
    ),
  ).toMatch(/table edits/);
  expect(updateBlocker([], 1)).toMatch(/close all connections/);
});
it("ignores an empty insertion row and generated SQL in table tabs", () => {
  expect(updateBlocker([tab({ staged: emptyStaged() })], 0)).toBeNull();
  expect(
    updateBlocker(
      [
        tab({
          query: "SELECT * FROM users",
          tableIdentity: { database: "app", schema: "", name: "users" },
        }),
      ],
      0,
    ),
  ).toBeNull();
});
