import type { ColumnInfo } from "../types";
import type { StructureField } from "./table-structure";
import { splitFieldType } from "./table-structure";
import { validateValue } from "./value-validation";
export interface FieldTypeEdit {
  name: string;
  length: string;
  decimals: string;
  unsigned: boolean;
  zerofill: boolean;
  values: string[];
}
export interface FieldDefaultEdit {
  kind: "none" | "null" | "value" | "expression";
  value: string;
}
export interface FieldPatch {
  data_type?: FieldTypeEdit;
  not_null?: boolean;
  comment?: string;
  default?: FieldDefaultEdit;
  charset?: string;
  collation?: string;
  generated?: boolean;
  stored?: boolean;
  expression?: string;
  primary?: boolean;
  auto_increment?: boolean;
}
export interface FieldChange {
  from: string;
  to: string;
  patch: FieldPatch;
}
export function initialFieldType(
  column: ColumnInfo,
  detail?: StructureField,
): FieldTypeEdit {
  const shape = detail ?? splitFieldType(column.data_type);
  const raw = shape.type;
  const enumType = raw.match(/^(enum|set)\((.*)\)$/is);
  const values = enumType
    ? Array.from(enumType[2].matchAll(/'((?:[^'\\]|\\.|'')*)'/g), (match) =>
        match[1].replaceAll("''", "'").replace(/\\(.)/g, "$1"),
      )
    : [];
  return {
    name:
      enumType?.[1] ??
      raw
        .replace(/\s+(unsigned|zerofill)\b/gi, "")
        .trim()
        .toLowerCase(),
    length: shape.length,
    decimals: shape.decimals,
    unsigned: /\bunsigned\b/i.test(raw),
    zerofill: /\bzerofill\b/i.test(raw),
    values,
  };
}
export const lengthType = (name: string) =>
  /^(?:int|integer|bigint|smallint|tinyint|mediumint|varchar|char|binary|varbinary|bit|decimal|numeric|float|double|datetime|timestamp|time)$/i.test(
    name,
  );
export const scaleType = (name: string) =>
  /^(decimal|numeric|float|double)$/i.test(name);
export const numericType = (name: string) =>
  /^(?:int|integer|bigint|smallint|tinyint|mediumint|decimal|numeric|float|double)$/i.test(
    name,
  );
export const textType = (name: string) =>
  /^(?:varchar|char|tinytext|text|mediumtext|longtext|enum|set)$/i.test(name);
export function initialDefault(detail?: StructureField): FieldDefaultEdit {
  const raw = detail?.default_value;
  if (raw == null) return { kind: "none", value: "" };
  if (/^null$/i.test(raw)) return { kind: "null", value: "" };
  if (/^current_(timestamp|date|time)(\(\d?\))?$/i.test(raw))
    return { kind: "expression", value: raw.toUpperCase() };
  return {
    kind: "value",
    value:
      raw.startsWith("'") && raw.endsWith("'")
        ? raw
            .slice(1, -1)
            .replaceAll("''", "'")
            .replace(/\\(['\\])/g, "$1")
        : raw,
  };
}
export function fieldChangesError(
  columns: ColumnInfo[],
  details: StructureField[],
  changes: FieldChange[],
): string {
  for (const change of changes) {
    const column = columns.find((item) => item.name === change.from);
    if (!column) return "The table fields changed. Refresh the design.";
    const detail = details.find((item) => item.name === change.from),
      patch = change.patch;
    const type = patch.data_type ?? initialFieldType(column, detail);
    const required = patch.not_null ?? !column.nullable;
    const primary = patch.primary ?? detail?.primary ?? false;
    const generated = patch.generated ?? detail?.generated ?? false;
    if (patch.data_type) {
      if (!/^[a-z][a-z ]*$/i.test(type.name))
        return `${change.to}: choose a supported data type.`;
      if (!/^\d*$/.test(type.length) || !/^\d*$/.test(type.decimals))
        return `${change.to}: length and decimals must be whole numbers.`;
      if (["enum", "set"].includes(type.name) && !type.values.length)
        return `${change.to}: provide the allowed enum/set values.`;
      if (
        ["varchar", "char", "binary", "varbinary", "bit"].includes(type.name) &&
        (!type.length || Number(type.length) < 1)
      )
        return `${change.to}: this type requires a positive length.`;
      if (type.length && Number(type.length) > 65535)
        return `${change.to}: length must not exceed 65535.`;
      if (
        type.length &&
        Number(type.length) < 1 &&
        !/^(datetime|timestamp|time)$/.test(type.name)
      )
        return `${change.to}: length must be positive.`;
      if (
        /^(?:tinyint|smallint|mediumint|int|integer|bigint)$/.test(type.name) &&
        Number(type.length) > 255
      )
        return `${change.to}: integer display width must not exceed 255.`;
      if (
        /^(datetime|timestamp|time)$/.test(type.name) &&
        Number(type.length) > 6
      )
        return `${change.to}: date/time precision must be between 0 and 6.`;
      if (
        type.decimals &&
        (!scaleType(type.name) ||
          !type.length ||
          Number(type.decimals) > Number(type.length) ||
          Number(type.decimals) > 30)
      )
        return `${change.to}: decimals must fit within the numeric precision.`;
      if (/^(decimal|numeric)$/.test(type.name) && Number(type.length) > 65)
        return `${change.to}: decimal precision must not exceed 65.`;
    }
    if (primary && !required)
      return `${change.to}: primary key fields must be Not Null.`;
    if (
      (patch.auto_increment ?? detail?.auto_increment) &&
      (!/^(?:tinyint|smallint|mediumint|int|integer|bigint)$/.test(type.name) ||
        generated)
    )
      return `${change.to}: auto increment requires a regular integer field.`;
    if (generated && !(patch.expression ?? detail?.expression ?? "").trim())
      return `${change.to}: enter a generated field expression.`;
    const effectiveDefault =
      patch.default ?? (patch.data_type ? initialDefault(detail) : undefined);
    if (effectiveDefault) {
      if (generated && effectiveDefault.kind !== "none")
        return `${change.to}: generated fields cannot have a default.`;
      if (effectiveDefault.kind === "null" && (required || primary))
        return `${change.to}: a Not Null field cannot default to NULL.`;
      if (
        effectiveDefault.kind === "expression" &&
        !/^(date|datetime|timestamp|time)/.test(type.name)
      )
        return `${change.to}: date/time expressions require a date/time field.`;
      if (effectiveDefault.kind === "value") {
        if (
          type.name === "enum" &&
          !type.values.includes(effectiveDefault.value)
        )
          return `${change.to}: the default must be one of the allowed enum values.`;
        if (
          type.name === "set" &&
          effectiveDefault.value
            .split(",")
            .some((value) => value && !type.values.includes(value))
        )
          return `${change.to}: the default must use allowed set values.`;
        const dataType = `${type.name}${type.length ? `(${type.length}${type.decimals ? `,${type.decimals}` : ""})` : ""}${type.unsigned ? " unsigned" : ""}`;
        const error = validateValue(
          { name: change.to, data_type: dataType, nullable: !required },
          effectiveDefault.value,
          "mysql",
        );
        if (error) return error;
      }
    }
    if (patch.comment && Array.from(patch.comment).length > 1024)
      return `${change.to}: comments are limited to 1024 characters.`;
    for (const value of [patch.charset, patch.collation])
      if (value && !/^[a-z0-9_]+$/i.test(value))
        return `${change.to}: charset and collation must be valid identifiers.`;
  }
  return "";
}
