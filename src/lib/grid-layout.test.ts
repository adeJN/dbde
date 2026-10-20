// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  columnMap,
  frozenOffsets,
  gridLayoutKey,
  isGridViewToggle,
  readGridLayout,
  writeGridLayout,
} from "./grid-layout";

const columns = ["id", "name", "email", "note"];
describe("columnMap", () => {
  it("is the identity when nothing is hidden or frozen", () => {
    const map = columnMap(columns, { hidden: [], frozen: [] });
    expect(map.order).toEqual([0, 1, 2, 3]);
    expect(map.names).toEqual(columns);
    expect(map.frozenCount).toBe(0);
    expect(map.toResult(2)).toBe(2);
    expect(map.toDisplay(3)).toBe(3);
  });
  it("skips hidden columns and maps both ways", () => {
    const map = columnMap(columns, { hidden: ["name"], frozen: [] });
    expect(map.order).toEqual([0, 2, 3]);
    expect(map.count).toBe(3);
    expect(map.toResult(1)).toBe(2);
    expect(map.toDisplay(1)).toBe(-1);
    expect(map.toDisplay(2)).toBe(1);
    expect(map.toResult(9)).toBe(-1);
  });
  it("puts frozen columns first in freeze order, ignoring hidden, unknown and repeated names", () => {
    const map = columnMap(columns, {
      hidden: ["email"],
      frozen: ["note", "missing", "email", "name", "note"],
    });
    expect(map.names).toEqual(["note", "name", "id"]);
    expect(map.frozenCount).toBe(2);
    expect(map.toDisplay(0)).toBe(2);
  });
  it("computes sticky offsets after the checkbox and row-number columns", () => {
    const map = columnMap(columns, { hidden: [], frozen: ["email", "id"] });
    expect(frozenOffsets([100, 120, 140, 160], map)).toEqual([82, 222]);
  });
});

describe("layout persistence", () => {
  let saved: Map<string, string>;
  beforeEach(() => {
    saved = new Map();
    vi.stubGlobal("localStorage", {
      getItem: (name: string) => saved.get(name) ?? null,
      setItem: (name: string, value: string) => saved.set(name, value),
      removeItem: (name: string) => saved.delete(name),
    });
  });
  afterEach(() => vi.unstubAllGlobals());
  it("keys layouts by profile, database, schema and table", () => {
    expect(gridLayoutKey("p1", "app", "public", "users")).toBe(
      'dbde.grid-layout:["p1","app","public","users"]',
    );
    expect(gridLayoutKey("p1", "app", "public", "users")).not.toBe(
      gridLayoutKey("p2", "app", "public", "users"),
    );
    // Separators inside names cannot make two tables collide.
    expect(gridLayoutKey("p", "a:b", "", "c")).not.toBe(
      gridLayoutKey("p", "a", "b", "c"),
    );
  });
  it("round-trips a layout and clears storage when nothing is customised", () => {
    const key = gridLayoutKey("p1", "app", "", "users");
    writeGridLayout(key, columns, { hidden: ["note"], frozen: ["name"] });
    expect(readGridLayout(key, columns)).toEqual({
      hidden: ["note"],
      frozen: ["name"],
    });
    writeGridLayout(key, columns, { hidden: [], frozen: [] });
    expect(saved.has(key)).toBe(false);
  });
  it("resets when the table's columns changed or the stored value is invalid", () => {
    const key = gridLayoutKey("p1", "app", "", "users");
    writeGridLayout(key, columns, { hidden: ["note"], frozen: [] });
    expect(readGridLayout(key, [...columns, "added"])).toEqual({
      hidden: [],
      frozen: [],
    });
    expect(readGridLayout(key, ["id", "name", "note", "email"])).toEqual({
      hidden: [],
      frozen: [],
    });
    saved.set(key, "{not json");
    expect(readGridLayout(key, columns)).toEqual({ hidden: [], frozen: [] });
    saved.set(
      key,
      JSON.stringify({ columns, hidden: ["note", 3, "ghost"], frozen: "id" }),
    );
    expect(readGridLayout(key, columns)).toEqual({
      hidden: ["note"],
      frozen: [],
    });
  });
  it("survives storage that throws", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => {
        throw new Error("denied");
      },
      setItem: () => {
        throw new Error("full");
      },
      removeItem: () => {
        throw new Error("denied");
      },
    });
    expect(() =>
      writeGridLayout("k", columns, { hidden: ["id"], frozen: [] }),
    ).not.toThrow();
    expect(readGridLayout("k", columns)).toEqual({ hidden: [], frozen: [] });
  });
});

describe("Grid/Form toggle shortcut", () => {
  const key = (patch: Partial<Parameters<typeof isGridViewToggle>[0]>) => ({
    key: "F",
    code: "KeyF",
    ctrlKey: false,
    metaKey: false,
    shiftKey: true,
    altKey: false,
    ...patch,
  });
  it("uses ⇧⌘F on macOS and Ctrl+Shift+F elsewhere, never plain Find", () => {
    expect(isGridViewToggle(key({ metaKey: true }), true)).toBe(true);
    expect(isGridViewToggle(key({ ctrlKey: true }), true)).toBe(false);
    expect(isGridViewToggle(key({ ctrlKey: true }), false)).toBe(true);
    expect(isGridViewToggle(key({ metaKey: true }), false)).toBe(false);
    expect(
      isGridViewToggle(key({ ctrlKey: true, shiftKey: false }), false),
    ).toBe(false);
    expect(isGridViewToggle(key({ metaKey: true, altKey: true }), true)).toBe(
      false,
    );
    expect(
      isGridViewToggle(key({ ctrlKey: true, code: "KeyH", key: "H" }), false),
    ).toBe(false);
  });
});
