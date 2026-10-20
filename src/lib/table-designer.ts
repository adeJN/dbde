import type { Driver, TableInfo } from "../types";
import { quoteIdentifier, qualifiedName } from "./sql";
import { validateValue } from "./value-validation";

export interface DesignField {
  id: string;
  name: string;
  type: string;
  length: string;
  decimals: string;
  notNull: boolean;
  primary: boolean;
  autoIncrement: boolean;
  unsigned: boolean;
  defaultKind: "none" | "null" | "value" | "expression";
  defaultValue: string;
  comment: string;
  values: string;
}
export interface DesignIndex {
  id: string;
  name: string;
  unique: boolean;
  fields: string[];
}
export interface DesignForeignKey {
  id: string;
  name: string;
  fields: string[];
  referenceSchema: string;
  referenceTable: string;
  referenceFields: string;
  onDelete: string;
  onUpdate: string;
}
export interface DesignCheck {
  id: string;
  name: string;
  expression: string;
}
export interface TableDesign {
  name: string;
  schema: string;
  fields: DesignField[];
  indexes: DesignIndex[];
  foreignKeys: DesignForeignKey[];
  checks: DesignCheck[];
  comment: string;
  engine: string;
  charset: string;
  collation: string;
}
export const fieldTypes: Record<Driver, string[]> = {
  mysql: [
    "int",
    "bigint",
    "smallint",
    "tinyint",
    "mediumint",
    "varchar",
    "char",
    "text",
    "mediumtext",
    "longtext",
    "decimal",
    "float",
    "double",
    "date",
    "datetime",
    "timestamp",
    "time",
    "year",
    "json",
    "boolean",
    "enum",
    "set",
    "blob",
    "longblob",
    "binary",
    "varbinary",
    "bit",
  ],
  postgres: [
    "integer",
    "bigint",
    "smallint",
    "varchar",
    "char",
    "text",
    "numeric",
    "real",
    "double precision",
    "boolean",
    "date",
    "timestamp",
    "timestamp with time zone",
    "time",
    "uuid",
    "json",
    "jsonb",
    "bytea",
  ],
  sqlite: [
    "INTEGER",
    "TEXT",
    "REAL",
    "NUMERIC",
    "BLOB",
    "VARCHAR",
    "BOOLEAN",
    "DATE",
    "DATETIME",
  ],
};
export const newField = (driver: Driver, name = ""): DesignField => ({
  id: crypto.randomUUID(),
  name,
  type: fieldTypes[driver][0],
  length: "",
  decimals: "",
  notNull: name === "id",
  primary: name === "id",
  autoIncrement: name === "id",
  unsigned: false,
  defaultKind: "none",
  defaultValue: "",
  comment: "",
  values: "",
});
export const newTableDesign = (
  driver: Driver,
  database: string,
): TableDesign => ({
  name: "",
  schema: driver === "postgres" ? "public" : driver === "mysql" ? database : "",
  fields: [newField(driver, "id")],
  indexes: [],
  foreignKeys: [],
  checks: [],
  comment: "",
  engine: "InnoDB",
  charset: "",
  collation: "",
});
export const supportsLength = (type: string) =>
  /^(varchar|char|binary|varbinary|bit|decimal|numeric)$/i.test(type);
export const supportsDecimals = (type: string) =>
  /^(decimal|numeric)$/i.test(type);
export const supportsIdentity = (type: string) =>
  /^(int|integer|bigint|smallint|tinyint|mediumint)$/i.test(type);
export function sqlString(value: string, driver: Driver): string {
  if (value.includes("\0"))
    throw new Error("Text cannot contain NUL characters.");
  const escaped = (
    driver === "sqlite" ? value : value.replaceAll("\\", "\\\\")
  ).replaceAll("'", "''");
  return `${driver === "postgres" ? "E" : ""}'${escaped}'`;
}
function identifier(value: string, label: string, driver: Driver): string {
  if (
    !value.trim() ||
    value.includes("\0") ||
    new TextEncoder().encode(value).length >
      (driver === "postgres" ? 63 : driver === "mysql" ? 64 : 255)
  )
    throw new Error(
      `${label}: enter a name within the database identifier limit.`,
    );
  return quoteIdentifier(value, driver);
}
export function designFieldType(field: DesignField, driver: Driver): string {
  if (!fieldTypes[driver].includes(field.type))
    throw new Error(`${field.name || "Field"}: unsupported type.`);
  let type = field.type;
  if (/^(enum|set)$/i.test(type)) {
    const values = field.values.split("\n");
    if (!field.values || new Set(values).size !== values.length)
      throw new Error(
        `${field.name}: enter unique enum/set values, one per line.`,
      );
    type += `(${values.map((v) => sqlString(v, driver)).join(", ")})`;
  } else if (supportsLength(type)) {
    const required = /^(varchar|binary|varbinary)$/i.test(type);
    if (field.length) {
      if (
        !/^\d+$/.test(field.length) ||
        Number(field.length) < 1 ||
        Number(field.length) > 65535
      )
        throw new Error(
          `${field.name}: length/precision must be between 1 and 65535.`,
        );
      if (supportsDecimals(type)) {
        const precision = Number(field.length),
          scale = Number(field.decimals || 0);
        if (
          (driver === "mysql" && precision > 65) ||
          (driver === "postgres" && precision > 1000) ||
          !/^\d+$/.test(field.decimals || "0") ||
          scale > precision ||
          (driver === "mysql" && scale > 30)
        )
          throw new Error(`${field.name}: invalid decimal precision or scale.`);
        type += `(${precision},${scale})`;
      } else type += `(${Number(field.length)})`;
    } else if (required)
      throw new Error(`${field.name}: length is required for ${type}.`);
    else if (field.decimals)
      throw new Error(`${field.name}: enter precision before decimals.`);
  }
  if (field.unsigned) {
    if (
      driver !== "mysql" ||
      !/^(int|bigint|smallint|tinyint|mediumint|decimal|float|double)/.test(
        type,
      )
    )
      throw new Error(
        `${field.name}: unsigned is only available for MySQL numeric fields.`,
      );
    type += " UNSIGNED";
  }
  return type;
}

/** Produces one atomic MySQL CREATE; other drivers execute the plan in a transaction. */
export function buildTablePlan(
  design: TableDesign,
  driver: Driver,
  database: string,
): { table: TableInfo; statements: string[]; sql: string } {
  identifier(design.name, "Table", driver);
  if (driver === "postgres") identifier(design.schema, "Schema", driver);
  if (driver === "mysql" && design.schema !== database)
    throw new Error("The table must belong to the selected database.");
  if (driver === "sqlite" && design.schema && design.schema !== "main")
    throw new Error("Only the main SQLite database is supported.");
  if (!design.fields.length || design.fields.length > 256)
    throw new Error("Use between 1 and 256 fields.");
  if (
    design.indexes.length + design.foreignKeys.length + design.checks.length >
    100
  )
    throw new Error("Use at most 100 indexes and constraints.");
  const table: TableInfo = {
    name: design.name,
    schema: driver === "sqlite" ? "" : design.schema,
    kind: "table",
  };
  const target = qualifiedName(table, driver),
    primary = design.fields.filter((f) => f.primary);
  const names = new Set<string>();
  const ids = new Map(design.fields.map((f) => [f.id, f]));
  const list = (fields: string[]) => {
    if (!fields.length || new Set(fields).size !== fields.length)
      throw new Error(
        "Select one or more distinct fields for each index or foreign key.",
      );
    return fields
      .map((id) => {
        const f = ids.get(id);
        if (!f)
          throw new Error("An index or constraint references a deleted field.");
        return quoteIdentifier(f.name, driver);
      })
      .join(", ");
  };
  const identity = design.fields.filter((f) => f.autoIncrement);
  if (identity.length > 1)
    throw new Error("Use at most one auto-increment field.");
  const definitions = design.fields.map((f) => {
    const name = identifier(f.name, "Field", driver);
    const canonical = driver === "postgres" ? f.name : f.name.toLowerCase();
    if (names.has(canonical)) throw new Error(`Duplicate field: ${f.name}.`);
    names.add(canonical);
    const type = designFieldType(f, driver);
    if (
      f.autoIncrement &&
      (!supportsIdentity(f.type) ||
        (driver === "sqlite" &&
          (f.type !== "INTEGER" || primary.length !== 1 || !f.primary)) ||
        (driver === "mysql" && !f.primary))
    )
      throw new Error(
        `${f.name}: auto increment requires an integer field${driver === "postgres" ? "" : " in the primary key"}.`,
      );
    if (f.autoIncrement && driver === "mysql" && primary[0]?.id !== f.id)
      throw new Error(
        `${f.name}: the auto-increment field must be first in the primary key.`,
      );
    if (f.autoIncrement && f.defaultKind !== "none")
      throw new Error(
        `${f.name}: auto-increment fields cannot have an explicit default.`,
      );
    let sql = `${name} ${type}`;
    if (driver === "sqlite" && f.autoIncrement)
      sql += " PRIMARY KEY AUTOINCREMENT";
    if (f.notNull || f.primary || f.autoIncrement) sql += " NOT NULL";
    if (f.autoIncrement && driver === "mysql") sql += " AUTO_INCREMENT";
    if (f.autoIncrement && driver === "postgres")
      sql += " GENERATED BY DEFAULT AS IDENTITY";
    if (f.defaultKind === "null") {
      if (f.notNull || f.primary)
        throw new Error(`${f.name}: NOT NULL fields cannot default to NULL.`);
      sql += " DEFAULT NULL";
    } else if (f.defaultKind === "value") {
      const error = validateValue(
        { name: f.name, data_type: type, nullable: !f.notNull && !f.primary },
        f.defaultValue,
        driver,
      );
      if (error) throw new Error(error);
      // Numeric and boolean defaults are literals, text defaults are always quoted.
      const numeric =
        /^(int|integer|tinyint|smallint|mediumint|bigint|decimal|numeric|float|double|real)\b/i.test(
          type,
        );
      sql += ` DEFAULT ${numeric ? f.defaultValue.trim() : /^(boolean|bool)$/i.test(type) ? (/^(true|1)$/i.test(f.defaultValue.trim()) ? "TRUE" : "FALSE") : sqlString(f.defaultValue, driver)}`;
    } else if (f.defaultKind === "expression") {
      const expr = f.defaultValue.trim().toUpperCase();
      if (!["CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME"].includes(expr))
        throw new Error(
          `${f.name}: choose CURRENT_TIMESTAMP, CURRENT_DATE or CURRENT_TIME.`,
        );
      if (!/^(date|datetime|timestamp|time)/i.test(f.type))
        throw new Error(
          `${f.name}: date/time expressions require a date or time field.`,
        );
      sql += ` DEFAULT ${expr}`;
    }
    if (driver === "mysql" && f.comment)
      sql += ` COMMENT ${sqlString(f.comment, driver)}`;
    return sql;
  });
  if (primary.length && !(driver === "sqlite" && identity.length))
    definitions.push(
      `PRIMARY KEY (${primary.map((f) => quoteIdentifier(f.name, driver)).join(", ")})`,
    );
  const constraintNames = new Set<string>();
  const constraintName = (name: string) => {
    const quoted = identifier(name, "Index/constraint", driver);
    const canonical = driver === "postgres" ? name : name.toLowerCase();
    if (constraintNames.has(canonical) || canonical === "primary")
      throw new Error(`Duplicate or reserved index/constraint name: ${name}.`);
    constraintNames.add(canonical);
    return quoted;
  };
  const later: string[] = [];
  for (const index of design.indexes) {
    const name = constraintName(index.name),
      columns = list(index.fields);
    if (driver === "mysql")
      definitions.push(
        `${index.unique ? "UNIQUE " : ""}INDEX ${name} (${columns})`,
      );
    else
      later.push(
        `CREATE ${index.unique ? "UNIQUE " : ""}INDEX ${name} ON ${target} (${columns});`,
      );
  }
  for (const fk of design.foreignKeys) {
    const name = constraintName(fk.name),
      local = list(fk.fields);
    identifier(fk.referenceTable, "Referenced table", driver);
    const remote = fk.referenceFields.split(",").map((c) => c.trim());
    if (remote.length !== fk.fields.length)
      throw new Error(
        `${fk.name}: local and referenced field counts must match.`,
      );
    const remoteColumns = remote
      .map((c) => identifier(c, "Referenced field", driver))
      .join(", ");
    if (fk.referenceSchema)
      identifier(fk.referenceSchema, "Referenced schema", driver);
    if (
      driver === "sqlite" &&
      fk.referenceSchema &&
      fk.referenceSchema !== "main"
    )
      throw new Error("SQLite foreign keys cannot cross databases.");
    const reference = qualifiedName(
      {
        name: fk.referenceTable,
        schema: driver === "sqlite" ? "" : fk.referenceSchema,
        kind: "table",
      },
      driver,
    );
    const actions = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL"];
    if (![fk.onDelete, fk.onUpdate].every((a) => actions.includes(a)))
      throw new Error(`${fk.name}: unsupported foreign-key action.`);
    if (
      [fk.onDelete, fk.onUpdate].includes("SET NULL") &&
      fk.fields.some((id) => ids.get(id)?.notNull || ids.get(id)?.primary)
    )
      throw new Error(`${fk.name}: SET NULL requires nullable local fields.`);
    definitions.push(
      `CONSTRAINT ${name} FOREIGN KEY (${local}) REFERENCES ${reference} (${remoteColumns}) ON DELETE ${fk.onDelete} ON UPDATE ${fk.onUpdate}`,
    );
  }
  for (const check of design.checks) {
    const name = constraintName(check.name);
    if (
      !check.expression.trim() ||
      /;|--|\/\*|\*\/|\0/.test(check.expression) ||
      check.expression.length > 10000
    )
      throw new Error(
        `${check.name}: enter a single check expression without SQL comments or semicolons.`,
      );
    definitions.push(`CONSTRAINT ${name} CHECK (${check.expression})`);
  }
  let sql = `CREATE TABLE ${target} (\n  ${definitions.join(",\n  ")}\n)`;
  if (driver === "mysql") {
    if (design.engine !== "InnoDB")
      throw new Error(
        "The designer uses InnoDB for foreign keys and reliable record transactions.",
      );
    sql += " ENGINE=InnoDB";
    for (const [key, value] of [
      ["DEFAULT CHARSET", design.charset],
      ["COLLATE", design.collation],
    ]) {
      if (value) {
        if (!/^[a-zA-Z0-9_]+$/.test(value)) throw new Error(`Invalid ${key}.`);
        sql += ` ${key}=${value}`;
      }
    }
    if (design.comment) sql += ` COMMENT=${sqlString(design.comment, driver)}`;
  }
  if (driver === "postgres") {
    if (design.comment)
      later.push(
        `COMMENT ON TABLE ${target} IS ${sqlString(design.comment, driver)};`,
      );
    for (const f of design.fields)
      if (f.comment)
        later.push(
          `COMMENT ON COLUMN ${target}.${quoteIdentifier(f.name, driver)} IS ${sqlString(f.comment, driver)};`,
        );
  }
  const statements = [sql + ";", ...later];
  return { table, statements, sql: statements.join("\n\n") };
}
