import { isMacPlatform } from "./table-shortcuts";

/** Shared by virtualization, page-key navigation and the grid's CSS row height. */
export const GRID_ROW_HEIGHT = 32;

/**
 * Which result columns the data grid shows, and in which order. Hidden columns are not
 * rendered; frozen columns come first (in the order they were frozen) and stay at the
 * left while scrolling horizontally.
 */
export interface GridLayout {
  hidden: string[];
  frozen: string[];
}
export const emptyGridLayout = (): GridLayout => ({ hidden: [], frozen: [] });

/**
 * Maps between a displayed column position ("display index", what keyboard focus,
 * cell blocks, find matches and `data-grid-col` use) and the index into
 * `result.columns` / row values ("result index", what staged edits and values use).
 */
export interface ColumnMap {
  /** Result indexes in displayed order. */
  order: number[];
  /** Displayed column names, in displayed order. */
  names: string[];
  /** How many leading displayed columns are frozen. */
  frozenCount: number;
  count: number;
  /** Result index of a displayed column. */
  toResult: (display: number) => number;
  /** Displayed position of a result column, or -1 when it is hidden. */
  toDisplay: (resultIndex: number) => number;
}
export function columnMap(columns: string[], layout: GridLayout): ColumnMap {
  const hidden = new Set(layout.hidden);
  const frozen = layout.frozen
    .map((name) => columns.indexOf(name))
    .filter(
      (index, position, list) =>
        index >= 0 &&
        !hidden.has(columns[index]) &&
        list.indexOf(index) === position,
    );
  const rest = columns.flatMap((name, index) =>
    hidden.has(name) || frozen.includes(index) ? [] : [index],
  );
  const order = [...frozen, ...rest];
  const positions = new Map(order.map((index, display) => [index, display]));
  return {
    order,
    names: order.map((index) => columns[index]),
    frozenCount: frozen.length,
    count: order.length,
    toResult: (display) => order[display] ?? -1,
    toDisplay: (resultIndex) => positions.get(resultIndex) ?? -1,
  };
}
/** Left offsets of the frozen columns, after the checkbox and row-number columns. */
export function frozenOffsets(
  widths: number[],
  map: Pick<ColumnMap, "order" | "frozenCount">,
  start = 82,
) {
  const offsets: number[] = [];
  let left = start;
  for (let display = 0; display < map.frozenCount; display++) {
    offsets.push(left);
    left += widths[map.order[display]] ?? 0;
  }
  return offsets;
}
/** Storage key: one layout per connection profile, database, schema and table. */
export function gridLayoutKey(
  profileId: string,
  database: string,
  schema: string,
  table: string,
) {
  return `dbde.grid-layout:${JSON.stringify([profileId, database, schema, table])}`;
}
const names = (value: unknown, columns: string[]) =>
  Array.isArray(value)
    ? value.filter(
        (name, index): name is string =>
          typeof name === "string" &&
          columns.includes(name) &&
          value.indexOf(name) === index,
      )
    : [];
/**
 * Reads a saved layout. A layout saved for a different column list (the table was
 * altered) is ignored, so the grid resets to showing every column.
 */
export function readGridLayout(key: string, columns: string[]): GridLayout {
  try {
    const value = JSON.parse(window.localStorage.getItem(key) ?? "null");
    if (
      !value ||
      typeof value !== "object" ||
      !Array.isArray(value.columns) ||
      value.columns.length !== columns.length ||
      value.columns.some((name: unknown, i: number) => name !== columns[i])
    )
      return emptyGridLayout();
    return {
      hidden: names(value.hidden, columns),
      frozen: names(value.frozen, columns),
    };
  } catch {
    return emptyGridLayout();
  }
}
export function writeGridLayout(
  key: string,
  columns: string[],
  layout: GridLayout,
) {
  try {
    if (!layout.hidden.length && !layout.frozen.length)
      window.localStorage.removeItem(key);
    else
      window.localStorage.setItem(
        key,
        JSON.stringify({
          columns,
          hidden: layout.hidden,
          frozen: layout.frozen,
        }),
      );
  } catch {
    /* Private browsing may disable storage; the layout still applies until reload. */
  }
}

/**
 * Ctrl/⌘+Shift+F switches the data grid between Grid and Form view. On macOS only ⌘
 * counts, elsewhere only Ctrl; Find (Ctrl/⌘+F) and macOS Replace (⌥⌘F) do not use
 * Shift, and no other grid, editor, table list or library shortcut uses this key.
 */
export function isGridViewToggle(
  event: {
    key: string;
    code?: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
  },
  mac = isMacPlatform(),
) {
  const command = mac
    ? event.metaKey && !event.ctrlKey
    : event.ctrlKey && !event.metaKey;
  if (!command || !event.shiftKey || event.altKey) return false;
  return event.code ? event.code === "KeyF" : event.key.toLowerCase() === "f";
}
export const gridViewToggleLabel = (mac = isMacPlatform()) =>
  mac ? "⇧⌘F" : "Ctrl+Shift+F";
