import { describe, expect, it } from "vitest";
import type { QueryResult } from "../types";
import {
  blankDraft,
  buildChanges,
  clearApplied,
  discardRecord,
  effectiveValue,
  emptyStaged,
  isMarkedDeleted,
  pendingCount,
  recordId,
  setDraftValue,
  stageDraftValues,
  stageValue,
  toggleDeletes,
} from "./staged";
const result: QueryResult = {
  columns: ["id", "name", "note"],
  rows: [
    [1, "Ada", null],
    [2, "Bob", "x"],
  ],
  affected_rows: 0,
  execution_ms: 0,
  truncated: false,
  source: {
    database: "app",
    table: { name: "people", schema: "", kind: "table" },
    primary_keys: ["id"],
  },
};
const [ada, bob] = result.rows;
describe("staged changes", () => {
  it("stages edits and drops them when set back to the stored value", () => {
    let staged = stageValue(emptyStaged(), result, ada, 1, "Ada L.");
    expect(effectiveValue(staged, result, ada, 1)).toBe("Ada L.");
    expect(pendingCount(staged)).toBe(1);
    staged = stageValue(staged, result, ada, 1, "Ada");
    expect(staged.edits).toEqual({});
    // NULL stays NULL; an empty string is a real change from NULL.
    expect(stageValue(staged, result, ada, 2, null).edits).toEqual({});
    expect(stageValue(staged, result, ada, 2, "").edits).toEqual({
      "[1]": { key: { id: 1 }, values: { note: "" } },
    });
  });
  it("keeps an edit on its record when the result is reloaded, re-sorted or paged", () => {
    const staged = stageValue(emptyStaged(), result, bob, 1, "Robert");
    // Same records, different order and a new array (a reload or another page).
    const reloaded: QueryResult = {
      ...result,
      rows: [
        [7, "Zed", null],
        [2, "Bob", "x"],
      ],
    };
    expect(effectiveValue(staged, reloaded, reloaded.rows[0], 1)).toBe("Zed");
    expect(effectiveValue(staged, reloaded, reloaded.rows[1], 1)).toBe(
      "Robert",
    );
    expect(buildChanges(staged, false)).toEqual([
      { kind: "update", key: { id: 2 }, values: { name: "Robert" } },
    ]);
  });
  it("refuses to stage rows that have no usable primary key", () => {
    expect(recordId(result, [null, "No key", null])).toBeNull();
    const staged = stageValue(emptyStaged(), result, [null, "x", null], 1, "y");
    expect(staged.edits).toEqual({});
    expect(
      recordId(
        { ...result, source: { ...result.source!, primary_keys: [] } },
        ada,
      ),
    ).toBeNull();
  });
  it("builds updates, deletes and inserts for one transaction", () => {
    let staged = stageValue(emptyStaged(), result, ada, 2, "hello");
    staged = toggleDeletes(staged, result, [bob]);
    expect(isMarkedDeleted(staged, result, bob)).toBe(true);
    staged = stageDraftValues(staged, [
      { draft: 0, column: "name", value: "Cy" },
      { draft: 1, column: "name", value: "Di" },
    ]);
    // Pasting from the blank row adds rows above it; the blank row stays empty.
    expect(staged.drafts).toHaveLength(3);
    expect(staged.drafts[0]).toMatchObject({
      copy: true,
      values: { name: "Cy" },
    });
    expect(staged.drafts[2].values).toEqual({});
    expect(buildChanges(staged, true)).toEqual([
      { kind: "update", key: { id: 1 }, values: { note: "hello" } },
      { kind: "delete", key: { id: 2 } },
      { kind: "insert", values: { name: "Cy" } },
      { kind: "insert", values: { name: "Di" } },
    ]);
    expect(buildChanges(staged, false)).toHaveLength(2);
    const cleared = clearApplied(staged, staged, true);
    expect(pendingCount(cleared)).toBe(0);
    expect(cleared.drafts).toEqual([{ key: staged.drafts[2].key, values: {} }]);
    expect(clearApplied(staged, staged, false).drafts).toHaveLength(3);
    // Pressing delete again on the same rows unmarks them.
    expect(
      isMarkedDeleted(toggleDeletes(staged, result, [bob]), result, bob),
    ).toBe(false);
  });
  it("does not update a row that is also being deleted", () => {
    const staged = toggleDeletes(
      stageValue(emptyStaged(), result, bob, 1, "B"),
      result,
      [bob],
    );
    expect(buildChanges(staged, false)).toEqual([
      { kind: "delete", key: { id: 2 } },
    ]);
  });
  it("clears only what a save sent, keeping edits made while it ran", () => {
    const sent = stageValue(emptyStaged(), result, ada, 1, "Ada L.");
    // While the save is in flight: another column, another record, a new draft,
    // and the same cell changed again.
    let current = stageValue(sent, result, ada, 2, "added");
    current = stageValue(current, result, bob, 1, "Robert");
    current = stageDraftValues(current, [
      { draft: 0, column: "name", value: "New" },
    ]);
    const cleared = clearApplied(current, sent, true);
    expect(cleared.edits).toEqual({
      "[1]": { key: { id: 1 }, values: { note: "added" } },
      "[2]": { key: { id: 2 }, values: { name: "Robert" } },
    });
    expect(cleared.drafts.filter((d) => d.copy)).toHaveLength(1);
    const again = stageValue(sent, result, ada, 1, "Ada Lovelace");
    expect(clearApplied(again, sent, false).edits).toEqual({
      "[1]": { key: { id: 1 }, values: { name: "Ada Lovelace" } },
    });
  });
  it("discards one record's changes only", () => {
    let staged = stageValue(emptyStaged(), result, ada, 1, "A");
    staged = stageValue(staged, result, bob, 1, "B");
    expect(Object.keys(discardRecord(staged, result, ada).edits)).toEqual([
      "[2]",
    ]);
  });
});
describe("setDraftValue", () => {
  it("keeps the draft's key, clears to default and adds a blank row when the last fills", () => {
    const blank = blankDraft();
    const filled = setDraftValue([blank], 0, "name", "Ada");
    expect(filled).toHaveLength(2);
    expect(filled[0]).toEqual({ key: blank.key, values: { name: "Ada" } });
    expect(filled[1].values).toEqual({});
    const nulled = setDraftValue(filled, 0, "note", null);
    expect(nulled[0].values).toEqual({ name: "Ada", note: null });
    expect(nulled).toHaveLength(2);
    expect(setDraftValue(nulled, 0, "note", undefined)[0].values).toEqual({
      name: "Ada",
    });
  });
});

it("keeps original composite identity when both key and normal fields are changed or deleted", () => {
  const view = {
    ...result,
    source: { ...result.source!, primary_keys: ["id", "name"] },
  };
  let staged = stageValue(emptyStaged(), view, ada, 0, "10");
  staged = stageValue(staged, view, ada, 1, "New name");
  staged = stageValue(staged, view, ada, 2, "updated");
  expect(buildChanges(staged, false)).toEqual([
    {
      kind: "update",
      key: { id: 1, name: "Ada" },
      values: { id: "10", name: "New name", note: "updated" },
    },
  ]);
  expect(buildChanges(toggleDeletes(staged, view, [ada]), false)).toEqual([
    { kind: "delete", key: { id: 1, name: "Ada" } },
  ]);
  expect(clearApplied(staged, staged, false).edits).toEqual({});
});
