import { describe, expect, it } from "vitest";
import {
  booleanState,
  booleanText,
  choiceIndex,
  choicesOf,
  editorSpec,
  formatTemporal,
  joinSet,
  localOffset,
  nowValue,
  parseChoices,
  parseTemporal,
  splitSet,
  zoneNote,
  type EditorSpec,
} from "./cell-editors";
import { validateValue } from "./value-validation";
import type { ColumnInfo } from "../types";

const column = (data_type: string, extra: Partial<ColumnInfo> = {}) => ({
  name: "c",
  data_type,
  nullable: true,
  ...extra,
});
type Temporal = Extract<EditorSpec, { kind: "temporal" }>;
const temporal = (data_type: string, driver: "postgres" | "mysql" | "sqlite") =>
  editorSpec(column(data_type), driver) as Temporal;
const roundTrip = (spec: Temporal, text: string) =>
  formatTemporal(spec, parseTemporal(text)!);

describe("ENUM and SET type text", () => {
  it("reads quotes, escaped quotes, commas and Unicode", () => {
    expect(parseChoices("enum('small','it''s','a,b')")).toEqual({
      set: false,
      values: ["small", "it's", "a,b"],
    });
    expect(
      parseChoices("SET( 'back\\\\slash' , 'quote\\'d', '日本', '🎉' )"),
    ).toEqual({
      set: true,
      values: ["back\\slash", "quote'd", "日本", "🎉"],
    });
    expect(parseChoices("enum('a)b','(c','')")?.values).toEqual([
      "a)b",
      "(c",
      "",
    ]);
    for (const text of [
      "varchar(3)",
      "enum('a'",
      "enum('a' 'b')",
      "enum(a)",
      "set('a') x",
    ])
      expect(parseChoices(text)).toBeNull();
  });
  it("splits and joins SET values in definition order", () => {
    expect(splitSet("red,blue")).toEqual(["red", "blue"]);
    expect(splitSet("")).toEqual([]);
    expect(splitSet(null)).toEqual([]);
    expect(joinSet(["blue", "red"], ["red", "green", "blue"])).toBe("red,blue");
    expect(joinSet([], ["red"])).toBe("");
  });
  it("validates against server-reported values, including PostgreSQL enums", () => {
    const mood = column("mood", { enum_values: ["calm", "it's, fine"] });
    expect(validateValue(mood, "it's, fine", "postgres")).toBeUndefined();
    expect(validateValue(mood, "angry", "postgres")).toContain(
      "Allowed values",
    );
    const tags = column("set('a','b')", { set_values: ["a", "b"] });
    expect(validateValue(tags, "a,b", "mysql")).toBeUndefined();
    expect(validateValue(tags, "", "mysql")).toBeUndefined();
    expect(validateValue(tags, "a,c", "mysql")).toContain("Allowed values");
    expect(
      validateValue(column("enum('x''y','z')"), "x'y", "mysql"),
    ).toBeUndefined();
  });
});

describe("editor kinds", () => {
  it("picks the editor from column metadata per driver", () => {
    expect(editorSpec(column("enum('a','b')"), "mysql")).toEqual({
      kind: "enum",
      values: ["a", "b"],
    });
    expect(editorSpec(column("set('a')"), "mysql")).toEqual({
      kind: "set",
      values: ["a"],
    });
    expect(
      editorSpec(column("mood", { enum_values: ["x"] }), "postgres"),
    ).toEqual({ kind: "enum", values: ["x"] });
    expect(editorSpec(column("boolean"), "postgres")).toEqual({
      kind: "boolean",
    });
    expect(
      editorSpec(column("tinyint(1)", { is_boolean: true }), "mysql"),
    ).toEqual({ kind: "boolean" });
    expect(editorSpec(column("tinyint(4)"), "mysql")).toBeNull();
    expect(editorSpec(column("timestamp[]"), "postgres")).toBeNull();
    expect(editorSpec(column("text"), "postgres")).toBeNull();
    expect(editorSpec(undefined, "postgres")).toBeNull();
    expect(temporal("timestamp(3) with time zone", "postgres")).toEqual({
      kind: "temporal",
      temporal: "datetime",
      zoned: true,
      precision: 3,
    });
    expect(temporal("datetime(6)", "mysql")).toMatchObject({
      temporal: "datetime",
      zoned: false,
      precision: 6,
    });
    expect(temporal("timestamp", "mysql")).toMatchObject({
      zoned: false,
      sessionZone: true,
    });
    expect(temporal("time with time zone", "postgres")).toMatchObject({
      temporal: "time",
      zoned: true,
    });
    expect(temporal("year(4)", "mysql").temporal).toBe("year");
    expect(temporal("DATE", "sqlite").temporal).toBe("date");
  });
});

describe("date and time text per driver", () => {
  it("keeps MySQL and SQLite formats and fractional seconds", () => {
    const mysql = temporal("datetime(6)", "mysql");
    expect(roundTrip(mysql, "2026-10-18 12:34:56.123456")).toBe(
      "2026-10-18 12:34:56.123456",
    );
    const sqlite = temporal("DATETIME", "sqlite");
    expect(roundTrip(sqlite, "2026-10-18T12:34:56")).toBe(
      "2026-10-18T12:34:56",
    );
    const parts = parseTemporal("2026-10-18 12:34:56.5")!;
    expect(formatTemporal(mysql, { ...parts, date: "2027-01-02" })).toBe(
      "2027-01-02 12:34:56.5",
    );
    expect(roundTrip(temporal("time", "mysql"), "838:59:59")).toBe("838:59:59");
    expect(roundTrip(temporal("date", "mysql"), "2026-02-28")).toBe(
      "2026-02-28",
    );
  });
  it("keeps the PostgreSQL offset text instead of converting time zones", () => {
    const zoned = temporal("timestamp with time zone", "postgres");
    expect(roundTrip(zoned, "2026-10-18 04:34:51.799544+07")).toBe(
      "2026-10-18 04:34:51.799544+07",
    );
    expect(roundTrip(zoned, "2026-10-13T15:42:11+00:00")).toBe(
      "2026-10-13T15:42:11+00:00",
    );
    expect(roundTrip(temporal("timetz", "postgres"), "04:34:51+05:30")).toBe(
      "04:34:51+05:30",
    );
    // Columns without a time zone never get an offset written.
    expect(
      roundTrip(temporal("timestamp", "postgres"), "2026-10-18 04:34:51+07"),
    ).toBe("2026-10-18 04:34:51");
    expect(parseTemporal("not a date")).toBeNull();
    // PostgreSQL's short offsets are valid input, not only ±HH:MM.
    const zonedColumn = column("timestamp with time zone");
    expect(
      validateValue(zonedColumn, "2026-10-18 04:34:51.799544+07", "postgres"),
    ).toBeUndefined();
    expect(
      validateValue(column("timetz"), "04:34:51+0530", "postgres"),
    ).toBeUndefined();
    expect(
      validateValue(zonedColumn, "2026-10-18 04:34:51+16", "postgres"),
    ).toContain("timezone");
    expect(parseTemporal("12:30")).toMatchObject({ time: "12:30:00" });
  });
  it("writes Now in local time, with this computer's offset for zoned columns", () => {
    const now = new Date(2026, 0, 2, 3, 4, 5, 678);
    expect(nowValue(temporal("datetime", "mysql"), now)).toBe(
      "2026-01-02 03:04:05",
    );
    expect(nowValue(temporal("datetime(6)", "mysql"), now)).toBe(
      "2026-01-02 03:04:05.678000",
    );
    expect(nowValue(temporal("date", "postgres"), now)).toBe("2026-01-02");
    expect(nowValue(temporal("time(2)", "postgres"), now)).toBe("03:04:05.67");
    expect(nowValue(temporal("timestamptz", "postgres"), now, "T")).toBe(
      `2026-01-02T03:04:05${localOffset(now)}`,
    );
    expect(localOffset(now)).toMatch(/^[+-]\d{2}:\d{2}$/);
    expect(zoneNote(temporal("timestamptz", "postgres"), "+07", now)).toContain(
      "Offset +07 kept",
    );
    expect(zoneNote(temporal("timestamp", "mysql"), "")).toContain(
      "session time zone",
    );
    expect(zoneNote(temporal("date", "mysql"), "")).toBe("");
  });
});

describe("boolean values", () => {
  it("reads common spellings and writes each driver's literal", () => {
    expect(booleanState(true)).toBe(true);
    expect(booleanState("t")).toBe(true);
    expect(booleanState(0)).toBe(false);
    expect(booleanState("FALSE")).toBe(false);
    expect(booleanState(null)).toBeNull();
    expect(booleanState("maybe")).toBeUndefined();
    expect(booleanText(true, "postgres")).toBe("true");
    expect(booleanText(false, "mysql")).toBe("0");
    expect(booleanText(true, "sqlite")).toBe("1");
  });
  it("lists true/false (and NULL when nullable) and finds the current entry", () => {
    const spec = { kind: "boolean" } as const;
    const choices = choicesOf(spec, "mysql", true);
    expect(choices).toEqual([
      { label: "true", value: "1" },
      { label: "false", value: "0" },
      { label: "NULL", value: null },
    ]);
    expect(choiceIndex(choices, spec, 0)).toBe(1);
    expect(choiceIndex(choices, spec, null)).toBe(2);
    const enumSpec = { kind: "enum" as const, values: ["", "a"] };
    const list = choicesOf(enumSpec, "mysql", false);
    expect(list[0].label).toBe("(empty string)");
    expect(choiceIndex(list, enumSpec, "a")).toBe(1);
    expect(choiceIndex(list, enumSpec, null)).toBe(-1);
  });
});
