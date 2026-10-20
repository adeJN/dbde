import type { ColumnInfo, Driver, RecordChange } from "../types";
import { parseChoices, splitSet } from "./cell-editors";

/** Validates literal editor values; database constraints remain authoritative. */
export function validateValue(
  column: ColumnInfo,
  value: string | null,
  driver: Driver = "sqlite",
): string | undefined {
  const type = column.data_type.toLowerCase().trim();
  const fail = (reason: string) =>
    `${column.name} (${column.data_type}): ${reason}`;
  if (value === null)
    return column.nullable ? undefined : fail("NULL is not allowed.");
  // Allowed values reported by the server (MySQL ENUM/SET, PostgreSQL enum types).
  const allowed = column.set_values ?? column.enum_values;
  if (allowed) {
    const values = column.set_values ? splitSet(value) : [value];
    return values.some((item) => !allowed.includes(item))
      ? fail(`Allowed values: ${allowed.join(", ")}.`)
      : undefined;
  }
  // PostgreSQL arrays/custom types are checked by the database, not scalar rules.
  if (driver === "postgres" && /\[\]$/.test(type)) return undefined;
  const text = value.trim();
  const base = type.replace(/\(.*/, "").trim();
  if (
    /^(tinyint|smallint|mediumint|int|integer|bigint|int2|int4|int8|serial|bigserial|smallserial)(\b|$)/.test(
      type,
    )
  ) {
    if (!/^[+-]?\d+$/.test(text))
      return fail("Enter a whole number (no decimals or text).");
    const bits =
      driver === "sqlite"
        ? 64
        : /^(tinyint)/.test(type)
          ? 8
          : /^(smallint|int2|smallserial)/.test(type)
            ? 16
            : /^mediumint/.test(type)
              ? 24
              : /^(bigint|int8|bigserial)/.test(type)
                ? 64
                : 32;
    const unsigned = /\bunsigned\b/.test(type);
    const n = BigInt(text);
    const max = (1n << BigInt(unsigned ? bits : bits - 1)) - 1n;
    const min = unsigned ? 0n : -(1n << BigInt(bits - 1));
    if (n < min || n > max)
      return fail(`Enter a number between ${min} and ${max}.`);
  } else if (/^(decimal|numeric|number|real|float|double|money)/.test(type)) {
    if (
      !/^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(text) ||
      (/^(real|float|double|money)/.test(type) &&
        !Number.isFinite(Number(text)))
    )
      return fail("Enter a valid finite number, using a dot for decimals.");
    const spec = type.match(
      /^(?:decimal|numeric|number)\((\d+)(?:,\s*(\d+))?\)/,
    );
    if (spec) {
      const precision = Number(spec[1]);
      const scale = Number(spec[2] ?? 0);
      const [mantissa, exponent = "0"] = text
        .toLowerCase()
        .replace(/^[+-]/, "")
        .split("e");
      const [whole, fraction = ""] = mantissa.split(".");
      const digits = whole + fraction;
      const point = whole.length + Number(exponent);
      const first = digits.search(/[1-9]/);
      const last = digits.search(/[1-9](?=0*$)/);
      if (
        first >= 0 &&
        (Math.max(0, point - first) > precision - scale ||
          Math.max(0, last + 1 - point) > scale)
      )
        return fail(
          `Maximum ${precision - scale} integer digits and ${scale} decimal places; value would be rounded or overflow.`,
        );
    }
    if (
      /^float4\b|^real\b/.test(type) &&
      Math.abs(Number(text)) > 3.4028234663852886e38
    )
      return fail("Number exceeds the range of this type.");
    if (/\bunsigned\b/.test(type) && Number(text) < 0)
      return fail("Enter a non-negative number.");
  } else if (/^(bool|boolean)\b/.test(type)) {
    if (!/^(true|false|0|1)$/i.test(text))
      return fail("Enter true, false, 0 or 1.");
  } else if (/^(json|jsonb)\b/.test(type)) {
    try {
      JSON.parse(value);
    } catch {
      return fail("Enter valid JSON.");
    }
  } else if (/^uuid\b/.test(type)) {
    if (
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(
        text,
      )
    )
      return fail(
        "Enter a UUID in xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx format.",
      );
  } else if (/^(date|datetime|timestamp)\b/.test(type)) {
    const match = text.match(
      /^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,6}))?(Z|[+-]\d{2}(?::?\d{2})?)?)?$/,
    );
    if (
      !match ||
      (base === "date" && match[4]) ||
      (base !== "date" && !match[4])
    )
      return fail(
        base === "date"
          ? "Use YYYY-MM-DD."
          : "Use YYYY-MM-DD HH:mm:ss (optional fractional seconds/timezone).",
      );
    const [, y, m, d, h = "0", min = "0", sec = "0", , zone] = match;
    const year = Number(y),
      month = Number(m),
      day = Number(d);
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    if (
      !year ||
      month < 1 ||
      month > 12 ||
      day < 1 ||
      day > days[month - 1] ||
      Number(h) > 23 ||
      Number(min) > 59 ||
      Number(sec) > 59
    )
      return fail("Enter a real calendar date and valid time.");
    if (
      zone &&
      zone !== "Z" &&
      (Number(zone.slice(1, 3)) > 15 ||
        Number(zone.replace(":", "").slice(3) || "0") > 59)
    )
      return fail("Invalid timezone offset.");
    if (
      zone &&
      (driver === "mysql" ||
        base === "datetime" ||
        /without time zone/.test(type))
    )
      return fail("This column expects a date/time without a timezone suffix.");
  } else if (/^(time|timetz)\b/.test(type)) {
    const match = text.match(
      /^(-?)(\d{2,3}):(\d{2}):(\d{2})(?:\.\d{1,6})?(Z|[+-]\d{2}(?::?\d{2})?)?$/,
    );
    if (
      !match ||
      Number(match[2]) > (driver === "mysql" ? 838 : 23) ||
      Number(match[3]) > 59 ||
      Number(match[4]) > 59 ||
      (driver !== "mysql" && match[1]) ||
      (driver === "mysql" && match[5])
    )
      return fail("Enter a valid HH:mm:ss time.");
  } else if (/^year\b/.test(type)) {
    if (
      !/^\d{4}$/.test(text) ||
      (Number(text) !== 0 && (Number(text) < 1901 || Number(text) > 2155))
    )
      return fail("Enter 0000 or a year between 1901 and 2155.");
  } else if (/^(enum|set)\(/.test(type)) {
    // Type text that cannot be read is left to the database to check.
    const choices = parseChoices(column.data_type)?.values;
    const values = /^set/.test(type) ? splitSet(value) : [value];
    if (choices && values.some((v) => !choices.includes(v)))
      return fail(`Allowed values: ${choices.join(", ")}.`);
  } else if (/^(bit|varbit|bit varying)\b/.test(type)) {
    const size = type.match(/\((\d+)\)/);
    if (driver === "mysql") {
      if (!/^\d+$/.test(text) || BigInt(text) >= 1n << BigInt(size?.[1] ?? "1"))
        return fail(
          "Enter an unsigned integer within this BIT column's range.",
        );
    } else if (
      !/^[01]+$/.test(text) ||
      (size &&
        (base === "bit"
          ? text.length !== Number(size[1])
          : text.length > Number(size[1])))
    ) {
      return fail(
        "Enter a binary string of the declared length (0 and 1 only).",
      );
    }
  }

  const length = type.match(
    /^(?:varchar|nvarchar|character varying|char|nchar|character)\((\d+)\)/,
  );
  if (length && [...value].length > Number(length[1]))
    return fail(`Maximum ${length[1]} characters.`);
  return undefined;
}

export function validateChanges(
  columns: ColumnInfo[],
  changes: RecordChange[],
  driver: Driver = "sqlite",
): void {
  const lookup = new Map(columns.map((column) => [column.name, column]));
  changes.forEach((change, index) => {
    if (change.kind === "delete") return;
    for (const [name, value] of Object.entries(change.values)) {
      const column = lookup.get(name);
      if (!column)
        throw new Error(
          `Record ${index + 1}: unknown column ${name}. Refresh the table.`,
        );
      const error = validateValue(column, value, driver);
      if (error) throw new Error(`Record ${index + 1}: ${error}`);
    }
  });
}
