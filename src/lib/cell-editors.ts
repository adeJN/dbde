import type { ColumnInfo, Driver } from "../types";

/**
 * Special cell editors (Navicat-style pickers) for date/time, ENUM, SET and boolean
 * columns. Values stay text in the database's own format: the pickers only help to
 * write that text, and typing it directly keeps working.
 */
export type TemporalKind = "date" | "time" | "datetime" | "year";
export type EditorSpec =
  | {
      kind: "temporal";
      temporal: TemporalKind;
      /** PostgreSQL `with time zone`: the value carries a UTC offset. */
      zoned: boolean;
      /** Declared fractional-second digits, e.g. 6 for DATETIME(6); null when not declared. */
      precision: number | null;
      /** MySQL TIMESTAMP is shown and entered in the session time zone. */
      sessionZone?: boolean;
    }
  | { kind: "enum"; values: string[] }
  | { kind: "set"; values: string[] }
  | { kind: "boolean" };

/**
 * Reads MySQL/MariaDB `enum('a','b')` / `set(...)` type text: single-quoted values with
 * `''` or backslash escapes; commas and any text may appear inside the quotes.
 */
export function parseChoices(
  dataType: string,
): { set: boolean; values: string[] } | null {
  const text = dataType.trim();
  const open = text.indexOf("(");
  if (open < 0) return null;
  const word = text.slice(0, open).trim().toLowerCase();
  if (word !== "enum" && word !== "set") return null;
  const values: string[] = [];
  let i = open + 1;
  const space = () => {
    while (i < text.length && /\s/.test(text[i])) i++;
  };
  const escapes: Record<string, string> = {
    n: "\n",
    t: "\t",
    r: "\r",
    "0": "\0",
    Z: "\u001a",
  };
  for (;;) {
    space();
    if (text[i++] !== "'") return null;
    let value = "";
    for (;;) {
      if (i >= text.length) return null;
      const char = text[i++];
      if (char === "'" && text[i] === "'") {
        value += "'";
        i++;
      } else if (char === "'") break;
      else if (char === "\\") {
        if (i >= text.length) return null;
        const next = text[i++];
        value += escapes[next] ?? next;
      } else value += char;
    }
    values.push(value);
    space();
    const separator = text[i++];
    if (separator === ",") continue;
    if (separator === ")") break;
    return null;
  }
  return text.slice(i).trim() ? null : { set: word === "set", values };
}

export function editorSpec(
  column: ColumnInfo | undefined,
  driver: Driver,
): EditorSpec | null {
  if (!column) return null;
  if (column.set_values) return { kind: "set", values: column.set_values };
  if (column.enum_values) return { kind: "enum", values: column.enum_values };
  const type = column.data_type.toLowerCase().replace(/\s+/g, " ").trim();
  if (driver === "postgres" && /\[\]$/.test(type)) return null;
  if (driver === "mysql") {
    const choices = parseChoices(column.data_type);
    if (choices)
      return { kind: choices.set ? "set" : "enum", values: choices.values };
  }
  if (column.is_boolean || /^(bool|boolean)$/.test(type))
    return { kind: "boolean" };
  const digits = type.match(/\((\d+)\)/);
  const precision = digits ? Number(digits[1]) : null;
  const base = type.replace(/\s*\(\d+\)/, "").trim();
  if (base === "date")
    return { kind: "temporal", temporal: "date", zoned: false, precision };
  if (base === "year")
    return { kind: "temporal", temporal: "year", zoned: false, precision };
  if (/^(time|time without time zone|time with time zone|timetz)$/.test(base))
    return {
      kind: "temporal",
      temporal: "time",
      zoned: driver === "postgres" && /with time zone|timetz/.test(base),
      precision,
    };
  if (
    /^(datetime|timestamp|timestamp without time zone|timestamp with time zone|timestamptz)$/.test(
      base,
    )
  )
    return {
      kind: "temporal",
      temporal: "datetime",
      zoned: driver === "postgres" && /with time zone|timestamptz/.test(base),
      precision,
      ...(driver === "mysql" && base === "timestamp"
        ? { sessionZone: true }
        : {}),
    };
  return null;
}

export interface TemporalParts {
  /** YYYY-MM-DD, or "" for a time-only value. */
  date: string;
  /** HH:MM:SS (MySQL TIME may have up to three hour digits and a sign). */
  time: string;
  /** Fractional-second digits without the dot. */
  fraction: string;
  /** UTC offset exactly as written (Z, +07, +05:30), or "". */
  zone: string;
  /** Between date and time: " " or "T", as the stored value had it. */
  separator: string;
}
const TEMPORAL =
  /^(\d{4,}-\d{2}-\d{2})?(?:([ T])?(-?\d{1,3}:\d{2}(?::\d{2})?)(?:\.(\d+))?)?\s*(Z|[+-]\d{2}(?::?\d{2}){0,2})?$/i;
export function parseTemporal(text: string): TemporalParts | null {
  const match = text.trim().match(TEMPORAL);
  if (!match || (!match[1] && !match[3])) return null;
  const time = match[3] ?? "";
  return {
    date: match[1] ?? "",
    time: /^-?\d{1,3}:\d{2}$/.test(time) ? `${time}:00` : time,
    fraction: match[4] ?? "",
    zone: match[5] ?? "",
    separator: match[2] ?? " ",
  };
}
/** Writes picker parts back as text in the column's format. */
export function formatTemporal(
  spec: Extract<EditorSpec, { kind: "temporal" }>,
  parts: TemporalParts,
): string {
  const time = `${parts.time}${parts.fraction ? `.${parts.fraction}` : ""}`;
  const zone = spec.zoned ? parts.zone : "";
  switch (spec.temporal) {
    case "date":
      return parts.date;
    case "year":
      return parts.date.slice(0, 4);
    case "time":
      return `${time}${zone}`;
    default:
      return `${parts.date}${parts.separator === "T" ? "T" : " "}${time}${zone}`;
  }
}
const pad = (value: number, size = 2) => String(value).padStart(size, "0");
/** This computer's UTC offset as ±HH:MM. */
export function localOffset(date = new Date()) {
  const minutes = -date.getTimezoneOffset();
  const sign = minutes < 0 ? "-" : "+";
  const absolute = Math.abs(minutes);
  return `${sign}${pad(Math.floor(absolute / 60))}:${pad(absolute % 60)}`;
}
/**
 * The current local date/time as picker parts. Zoned columns get this computer's
 * offset, never an offset taken from another value, so the instant stays correct.
 */
export function nowParts(
  spec: Extract<EditorSpec, { kind: "temporal" }>,
  now = new Date(),
  separator = " ",
): TemporalParts {
  const digits =
    spec.precision && spec.temporal !== "year" ? spec.precision : 0;
  return {
    date: `${pad(now.getFullYear(), 4)}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`,
    time: `${pad(now.getHours())}:${pad(now.getMinutes())}:${pad(now.getSeconds())}`,
    fraction: digits
      ? pad(now.getMilliseconds(), 3).padEnd(digits, "0").slice(0, digits)
      : "",
    zone: spec.zoned ? localOffset(now) : "",
    separator,
  };
}
export function nowValue(
  spec: Extract<EditorSpec, { kind: "temporal" }>,
  now = new Date(),
  separator = " ",
) {
  return formatTemporal(spec, nowParts(spec, now, separator));
}
/** A one-line explanation of the time zone the picker uses, shown below it. */
export function zoneNote(
  spec: Extract<EditorSpec, { kind: "temporal" }>,
  storedZone: string,
  now = new Date(),
) {
  if (spec.zoned)
    return storedZone
      ? `Offset ${storedZone} kept from the loaded value. Now uses this computer's offset (UTC${localOffset(now)}).`
      : `New values use this computer's offset (UTC${localOffset(now)}).`;
  if (spec.sessionZone)
    return "MySQL TIMESTAMP is shown and entered in the connection's session time zone.";
  if (spec.temporal === "date" || spec.temporal === "year") return "";
  return "No time zone: the value is stored as entered (Now uses this computer's clock).";
}

/** SET values as a list; NULL and "" are the empty set. */
export const splitSet = (text: string | null | undefined) =>
  text ? text.split(",") : [];
/** Joins chosen SET members in definition order, as MySQL stores them. */
export const joinSet = (chosen: string[], allowed: string[]) =>
  allowed.filter((value) => chosen.includes(value)).join(",");

/** true/false for recognised boolean values, null for NULL, undefined otherwise. */
export function booleanState(value: unknown): boolean | null | undefined {
  if (value == null) return null;
  const text = String(value).trim().toLowerCase();
  if (["true", "t", "1", "yes", "y", "on"].includes(text)) return true;
  if (["false", "f", "0", "no", "n", "off"].includes(text)) return false;
  return undefined;
}
/** The text written for a boolean: PostgreSQL true/false, MySQL and SQLite 1/0. */
export const booleanText = (state: boolean, driver: Driver) =>
  driver === "postgres" ? String(state) : state ? "1" : "0";

export interface Choice {
  label: string;
  value: string | null;
}
/** Dropdown entries of an ENUM or boolean column, NULL last when allowed. */
export function choicesOf(
  spec: Extract<EditorSpec, { kind: "enum" | "boolean" }>,
  driver: Driver,
  nullable: boolean,
): Choice[] {
  const list: Choice[] =
    spec.kind === "boolean"
      ? [
          { label: "true", value: booleanText(true, driver) },
          { label: "false", value: booleanText(false, driver) },
        ]
      : spec.values.map((value) => ({
          label: value === "" ? "(empty string)" : value,
          value,
        }));
  return nullable ? [...list, { label: "NULL", value: null }] : list;
}
/** Index of the entry matching a cell's current value, or -1. */
export function choiceIndex(
  choices: Choice[],
  spec: Extract<EditorSpec, { kind: "enum" | "boolean" }>,
  value: unknown,
) {
  if (spec.kind === "boolean") {
    const state = booleanState(value);
    return choices.findIndex((choice) =>
      state === null
        ? choice.value === null
        : choice.value !== null && booleanState(choice.value) === state,
    );
  }
  return choices.findIndex((choice) =>
    value == null ? choice.value === null : choice.value === String(value),
  );
}
