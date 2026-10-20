import type {
  DraftRecord,
  QueryResult,
  RecordChange,
  StagedChanges,
} from "../types";
import { rowKeys } from "./rows";
import { displayValue } from "./sql";

export const blankDraft = (): DraftRecord => ({
  key: crypto.randomUUID(),
  values: {},
});
export const emptyStaged = (): StagedChanges => ({
  edits: {},
  deletes: {},
  drafts: [blankDraft()],
  transaction: false,
});
export const filledDrafts = (staged: StagedChanges) =>
  staged.drafts.filter((draft) => Object.keys(draft.values).length);
export const pendingCount = (staged: StagedChanges, includeDrafts = true) =>
  Object.keys(staged.edits).length +
  Object.keys(staged.deletes).length +
  (includeDrafts ? filledDrafts(staged).length : 0);

/**
 * A stable identity for a stored row: its primary key values in key order. Null when
 * the row cannot be identified (no key, NULL/binary key), so it cannot be edited.
 */
export function recordId(result: QueryResult, values: unknown[]) {
  try {
    const key = rowKeys(result, [values])[0];
    return {
      id: JSON.stringify(result.source!.primary_keys.map((name) => key[name])),
      key,
    };
  } catch {
    return null;
  }
}
export function editOf(
  staged: StagedChanges,
  result: QueryResult,
  values: unknown[],
) {
  const record = recordId(result, values);
  return record ? staged.edits[record.id]?.values : undefined;
}
export function isMarkedDeleted(
  staged: StagedChanges,
  result: QueryResult,
  values: unknown[],
) {
  const record = recordId(result, values);
  return !!record && Object.hasOwn(staged.deletes, record.id);
}
/** The value a cell shows: its staged edit if any, otherwise the stored value. */
export function effectiveValue(
  staged: StagedChanges,
  result: QueryResult,
  values: unknown[] | undefined,
  column: number,
): unknown {
  if (!values) return undefined;
  const edit = editOf(staged, result, values);
  const name = result.columns[column];
  return edit && Object.hasOwn(edit, name) ? edit[name] : values[column];
}
/**
 * Stages one cell of a stored row. Setting a cell back to its stored value removes the
 * edit, so an untouched record never counts as changed. Rows without a usable primary
 * key are left alone (callers block editing them).
 */
export function stageValue(
  staged: StagedChanges,
  result: QueryResult,
  values: unknown[],
  column: number,
  value: string | null,
): StagedChanges {
  const record = recordId(result, values);
  if (!record) return staged;
  const name = result.columns[column];
  const stored = values[column];
  const unchanged =
    value === null
      ? stored == null
      : stored != null && value === displayValue(stored);
  const edit = { ...staged.edits[record.id]?.values };
  if (unchanged) delete edit[name];
  else edit[name] = value;
  const edits = { ...staged.edits };
  if (Object.keys(edit).length)
    edits[record.id] = { key: record.key, values: edit };
  else delete edits[record.id];
  return { ...staged, edits };
}
export function discardRecord(
  staged: StagedChanges,
  result: QueryResult,
  values: unknown[],
): StagedChanges {
  const record = recordId(result, values);
  if (!record || !staged.edits[record.id]) return staged;
  const edits = { ...staged.edits };
  delete edits[record.id];
  return { ...staged, edits };
}
/** Marks rows for deletion, or unmarks them when all are already marked. */
export function toggleDeletes(
  staged: StagedChanges,
  result: QueryResult,
  list: unknown[][],
): StagedChanges {
  const records = list
    .map((values) => recordId(result, values))
    .filter((record) => record !== null);
  const deletes = { ...staged.deletes };
  if (records.every((record) => Object.hasOwn(deletes, record.id)))
    for (const record of records) delete deletes[record.id];
  else for (const record of records) deletes[record.id] = record.key;
  return { ...staged, deletes };
}
/**
 * Sets draft cells by position in staged.drafts. Positions at or past the blank entry
 * row become new copy rows in order, so the blank row always stays last and empty.
 */
export function stageDraftValues(
  staged: StagedChanges,
  cells: { draft: number; column: string; value: string | null }[],
): StagedChanges {
  const blank = staged.drafts[staged.drafts.length - 1];
  const drafts = staged.drafts
    .slice(0, -1)
    .map((draft) => ({ ...draft, values: { ...draft.values } }));
  const existing = drafts.length;
  for (const { draft, column, value } of cells) {
    while (draft >= drafts.length) drafts.push({ ...blankDraft(), copy: true });
    drafts[draft].values[column] = value;
  }
  // New rows that ended up empty (gaps) are not kept.
  return {
    ...staged,
    drafts: [
      ...drafts.filter(
        (draft, index) => index < existing || Object.keys(draft.values).length,
      ),
      blank,
    ],
  };
}
/**
 * Sets (or with `undefined`, clears back to the column default) one value of a draft,
 * keeping the draft's identity. Filling the blank entry row adds a new blank row.
 */
export function setDraftValue(
  drafts: DraftRecord[],
  index: number,
  column: string,
  value: string | null | undefined,
): DraftRecord[] {
  const next = drafts.map((item, position) => {
    if (position !== index) return item;
    const values = { ...item.values };
    if (value === undefined) delete values[column];
    else values[column] = value;
    return { ...item, values };
  });
  if (Object.keys(next[next.length - 1].values).length) next.push(blankDraft());
  return next;
}
/** Turns staged work into changes for one transaction, in a stable order. */
export function buildChanges(
  staged: StagedChanges,
  includeDrafts: boolean,
): RecordChange[] {
  const updates: RecordChange[] = Object.entries(staged.edits)
    .filter(([id]) => !Object.hasOwn(staged.deletes, id))
    .map(([, edit]) => ({
      kind: "update",
      key: edit.key,
      values: edit.values,
    }));
  const deletes: RecordChange[] = Object.values(staged.deletes).map((key) => ({
    kind: "delete",
    key,
  }));
  const inserts: RecordChange[] = includeDrafts
    ? filledDrafts(staged).map((draft) => ({
        kind: "insert",
        values: draft.values,
      }))
    : [];
  return [...updates, ...deletes, ...inserts];
}
/**
 * Removes exactly what `sent` wrote from the current state. Anything staged after the
 * snapshot was taken (another column, another record, a new draft) is kept, so a save
 * that overlaps further editing never throws that editing away.
 */
export function clearApplied(
  current: StagedChanges,
  sent: StagedChanges,
  includeDrafts: boolean,
): StagedChanges {
  const edits = { ...current.edits };
  for (const [id, written] of Object.entries(sent.edits)) {
    if (Object.hasOwn(sent.deletes, id)) continue;
    const now = edits[id];
    if (!now) continue;
    const remaining = Object.fromEntries(
      Object.entries(now.values).filter(
        ([column, value]) =>
          !Object.hasOwn(written.values, column) ||
          written.values[column] !== value,
      ),
    );
    if (Object.keys(remaining).length)
      edits[id] = { ...now, values: remaining };
    else delete edits[id];
  }
  const deletes = { ...current.deletes };
  for (const id of Object.keys(sent.deletes)) {
    delete deletes[id];
    delete edits[id];
  }
  if (!includeDrafts) return { ...current, edits, deletes };
  const written = new Map(
    filledDrafts(sent).map((draft) => [draft.key, draft.values]),
  );
  const same = (a: DraftRecord["values"], b: DraftRecord["values"]) =>
    Object.keys(a).length === Object.keys(b).length &&
    Object.entries(a).every(([column, value]) => b[column] === value);
  const blank = current.drafts[current.drafts.length - 1];
  const kept = current.drafts.slice(0, -1).filter((draft) => {
    const values = written.get(draft.key);
    return !values || !same(values, draft.values);
  });
  const blankValues = written.get(blank.key);
  return {
    ...current,
    edits,
    deletes,
    drafts: [
      ...kept,
      blankValues && same(blankValues, blank.values)
        ? { key: blank.key, values: {} }
        : blank,
    ],
  };
}
