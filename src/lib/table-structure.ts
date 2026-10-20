import { execute } from "./api";
import type { Driver, QueryResult, TableInfo } from "../types";

export interface StructureField {
  name: string;
  nullable: boolean;
  type: string;
  length: string;
  decimals: string;
  default_value: string | null;
  charset: string | null;
  collation: string | null;
  comment: string;
  generated: boolean;
  stored: boolean;
  expression: string;
  primary: boolean;
  auto_increment: boolean;
}
export interface StructureDefinition {
  name: string;
  definition: string;
  timing?: string;
  event?: string;
}
export interface StructureDetails {
  fields: StructureField[];
  foreignKeys: StructureDefinition[];
  triggers: StructureDefinition[];
  checks: StructureDefinition[];
  options: Record<string, string | null>;
  comment: string | null;
  unavailable: string[];
}
export function splitFieldType(full: string) {
  const match = full.match(
    /^([\w ]+?)\s*\(\s*(\d+)\s*(?:,\s*(\d+)\s*)?\)(.*)$/,
  );
  return match
    ? {
        type: `${match[1]}${match[4]}`.trim(),
        length: match[2],
        decimals: match[3] ?? "",
      }
    : { type: full, length: "", decimals: "" };
}
// Metadata values are encoded as literals, independent of server backslash SQL modes.
function literal(value: string, driver: Driver) {
  const hex = Array.from(new TextEncoder().encode(value), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return driver === "mysql"
    ? `CONVERT(X'${hex}' USING utf8mb4)`
    : driver === "postgres"
      ? `convert_from(decode('${hex}', 'hex'), 'UTF8')`
      : `'${value.replaceAll("'", "''")}'`;
}
function records(result: QueryResult): Record<string, unknown>[] {
  return result.rows.map((row) =>
    Object.fromEntries(
      result.columns.map((column, index) => [column, row[index]]),
    ),
  );
}
const text = (value: unknown) => (value == null ? null : String(value));
const str = (value: unknown) => text(value) ?? "";

export async function loadTableDetails(
  connectionId: string,
  database: string,
  table: TableInfo,
  driver: Driver,
): Promise<StructureDetails> {
  const details: StructureDetails = {
    fields: [],
    foreignKeys: [],
    triggers: [],
    checks: [],
    options: {},
    comment: null,
    unavailable: [],
  };
  const read = async (section: string, sql: string) => {
    try {
      return records(await execute(connectionId, sql, database));
    } catch {
      details.unavailable.push(section);
      return [];
    }
  };
  const name = literal(table.name, driver),
    schema = literal(table.schema || database, driver);
  if (driver === "mysql") {
    const where = `TABLE_SCHEMA = ${schema} AND TABLE_NAME = ${name}`;
    const [fields, keys, triggers, checks, options] = await Promise.all([
      read(
        "Field details",
        `SELECT COLUMN_NAME AS name, COLUMN_TYPE AS full_type, COLUMN_DEFAULT AS default_value, CHARACTER_SET_NAME AS charset, COLLATION_NAME AS collation, COLUMN_COMMENT AS comment, EXTRA AS extra, GENERATION_EXPRESSION AS expression, COLUMN_KEY AS column_key, IS_NULLABLE AS nullable FROM information_schema.COLUMNS WHERE ${where} ORDER BY ORDINAL_POSITION`,
      ),
      read(
        "Foreign Keys",
        `SELECT k.CONSTRAINT_NAME AS name, k.COLUMN_NAME AS field, k.REFERENCED_TABLE_SCHEMA AS ref_schema, k.REFERENCED_TABLE_NAME AS ref_table, k.REFERENCED_COLUMN_NAME AS ref_field, r.UPDATE_RULE AS update_rule, r.DELETE_RULE AS delete_rule FROM information_schema.KEY_COLUMN_USAGE k JOIN information_schema.REFERENTIAL_CONSTRAINTS r ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME WHERE k.TABLE_SCHEMA = ${schema} AND k.TABLE_NAME = ${name} AND k.REFERENCED_TABLE_NAME IS NOT NULL ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION`,
      ),
      read(
        "Triggers",
        `SELECT TRIGGER_NAME AS name, ACTION_TIMING AS timing, EVENT_MANIPULATION AS event, ACTION_STATEMENT AS definition FROM information_schema.TRIGGERS WHERE EVENT_OBJECT_SCHEMA = ${schema} AND EVENT_OBJECT_TABLE = ${name} ORDER BY TRIGGER_NAME`,
      ),
      read(
        "Checks",
        `SELECT tc.CONSTRAINT_NAME AS name, cc.CHECK_CLAUSE AS definition FROM information_schema.TABLE_CONSTRAINTS tc JOIN information_schema.CHECK_CONSTRAINTS cc ON cc.CONSTRAINT_SCHEMA = tc.CONSTRAINT_SCHEMA AND cc.CONSTRAINT_NAME = tc.CONSTRAINT_NAME WHERE tc.TABLE_SCHEMA = ${schema} AND tc.TABLE_NAME = ${name} AND tc.CONSTRAINT_TYPE = 'CHECK' ORDER BY tc.CONSTRAINT_NAME`,
      ),
      read(
        "Options",
        `SELECT ENGINE AS engine, ROW_FORMAT AS row_format, TABLE_COLLATION AS collation, CAST(AUTO_INCREMENT AS CHAR) AS auto_increment, CREATE_OPTIONS AS create_options, TABLE_COMMENT AS comment FROM information_schema.TABLES WHERE ${where}`,
      ),
    ]);
    details.fields = fields.map((field) => ({
      name: str(field.name),
      nullable: field.nullable === "YES",
      ...splitFieldType(str(field.full_type)),
      default_value: text(field.default_value),
      charset: text(field.charset),
      collation: text(field.collation),
      comment: str(field.comment),
      generated: /(?:VIRTUAL|STORED|PERSISTENT) GENERATED/i.test(
        str(field.extra),
      ),
      stored: /STORED|PERSISTENT/i.test(str(field.extra)),
      expression: str(field.expression),
      primary: field.column_key === "PRI",
      auto_increment: /auto_increment/i.test(str(field.extra)),
    }));
    const grouped = new Map<string, typeof keys>();
    for (const key of keys)
      grouped.set(str(key.name), [...(grouped.get(str(key.name)) ?? []), key]);
    details.foreignKeys = Array.from(grouped, ([key, rows]) => ({
      name: key,
      definition: `(${rows.map((row) => str(row.field)).join(", ")}) → ${str(rows[0].ref_schema)}.${str(rows[0].ref_table)} (${rows.map((row) => str(row.ref_field)).join(", ")})\nON UPDATE ${str(rows[0].update_rule)} · ON DELETE ${str(rows[0].delete_rule)}`,
    }));
    details.triggers = triggers.map((row) => ({
      name: str(row.name),
      timing: str(row.timing),
      event: str(row.event),
      definition: str(row.definition),
    }));
    details.checks = checks.map((row) => ({
      name: str(row.name),
      definition: str(row.definition),
    }));
    if (options[0]) {
      details.comment = text(options[0].comment);
      details.options = Object.fromEntries(
        Object.entries(options[0])
          .filter(([key]) => key !== "comment")
          .map(([key, value]) => [key, text(value)]),
      );
    }
  } else if (driver === "postgres") {
    const relation = `c.relname = ${name} AND n.nspname = ${schema}`;
    const [fields, constraints, triggers, options] = await Promise.all([
      read(
        "Field details",
        `SELECT a.attname AS name, NOT a.attnotnull AS nullable, pg_catalog.format_type(a.atttypid,a.atttypmod) AS full_type, pg_get_expr(d.adbin,d.adrelid) AS default_value, col_description(c.oid,a.attnum) AS comment, a.attgenerated::text AS generated, a.attidentity::text AS identity, co.collname AS collation, EXISTS(SELECT 1 FROM pg_constraint p WHERE p.conrelid=c.oid AND p.contype='p' AND a.attnum=ANY(p.conkey)) AS primary FROM pg_attribute a JOIN pg_class c ON c.oid=a.attrelid JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_attrdef d ON d.adrelid=c.oid AND d.adnum=a.attnum LEFT JOIN pg_collation co ON co.oid=a.attcollation WHERE ${relation} AND a.attnum>0 AND NOT a.attisdropped ORDER BY a.attnum`,
      ),
      read(
        "Constraints",
        `SELECT con.conname AS name, con.contype::text AS kind, pg_get_constraintdef(con.oid,true) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${relation} AND con.contype IN ('f','c') ORDER BY con.conname`,
      ),
      read(
        "Triggers",
        `SELECT t.tgname AS name, pg_get_triggerdef(t.oid,true) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE ${relation} AND NOT t.tgisinternal ORDER BY t.tgname`,
      ),
      read(
        "Options",
        `SELECT c.relpersistence::text AS persistence, array_to_string(c.reloptions,', ') AS storage_options, ts.spcname AS tablespace, obj_description(c.oid,'pg_class') AS comment FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace LEFT JOIN pg_tablespace ts ON ts.oid=c.reltablespace WHERE ${relation}`,
      ),
    ]);
    details.fields = fields.map((field) => ({
      name: str(field.name),
      nullable: field.nullable === true,
      ...splitFieldType(str(field.full_type)),
      default_value: str(field.generated) ? null : text(field.default_value),
      charset: null,
      collation: text(field.collation),
      comment: str(field.comment),
      generated: !!str(field.generated),
      stored: field.generated === "s",
      expression: str(field.generated) ? str(field.default_value) : "",
      primary: field.primary === true,
      auto_increment:
        !!str(field.identity) || /^nextval\(/.test(str(field.default_value)),
    }));
    details.foreignKeys = constraints
      .filter((row) => row.kind === "f")
      .map((row) => ({ name: str(row.name), definition: str(row.definition) }));
    details.checks = constraints
      .filter((row) => row.kind === "c")
      .map((row) => ({ name: str(row.name), definition: str(row.definition) }));
    details.triggers = triggers.map((row) => ({
      name: str(row.name),
      definition: str(row.definition),
    }));
    if (options[0]) {
      details.comment = text(options[0].comment);
      details.options = Object.fromEntries(
        Object.entries(options[0])
          .filter(([key]) => key !== "comment")
          .map(([key, value]) => [key, text(value)]),
      );
    }
  } else {
    const [fields, keys, triggers, definition] = await Promise.all([
      read(
        "Field details",
        `SELECT name, type, "notnull" AS required, dflt_value, pk, hidden FROM pragma_table_xinfo(${name}) ORDER BY cid`,
      ),
      read(
        "Foreign Keys",
        `SELECT * FROM pragma_foreign_key_list(${name}) ORDER BY id, seq`,
      ),
      read(
        "Triggers",
        `SELECT name, sql AS definition FROM sqlite_master WHERE type='trigger' AND tbl_name=${name} ORDER BY name`,
      ),
      read(
        "Options",
        `SELECT sql FROM sqlite_master WHERE name=${name} AND type IN ('table','view')`,
      ),
    ]);
    details.fields = fields
      .filter((field) => Number(field.hidden) !== 1)
      .map((field) => ({
        name: str(field.name),
        nullable: !Number(field.required),
        ...splitFieldType(str(field.type)),
        default_value: text(field.dflt_value),
        charset: null,
        collation: null,
        comment: "",
        generated: Number(field.hidden) > 1,
        stored: Number(field.hidden) === 3,
        expression: "",
        primary: Number(field.pk) > 0,
        auto_increment: false,
      }));
    const grouped = new Map<string, typeof keys>();
    for (const key of keys)
      grouped.set(str(key.id), [...(grouped.get(str(key.id)) ?? []), key]);
    details.foreignKeys = Array.from(grouped, ([key, rows]) => ({
      name: `Foreign key ${Number(key) + 1}`,
      definition: `(${rows.map((row) => str(row.from)).join(", ")}) → ${str(rows[0].table)} (${rows.map((row) => str(row.to) || "primary key").join(", ")})\nON UPDATE ${str(rows[0].on_update)} · ON DELETE ${str(rows[0].on_delete)}`,
    }));
    details.triggers = triggers.map((row) => ({
      name: str(row.name),
      definition: str(row.definition),
    }));
    details.options = { definition: str(definition[0]?.sql) };
    // SQLite exposes CHECK constraints and collation only in CREATE SQL, not in catalog rows.
    details.unavailable.push("Checks", "Field collation");
  }
  return details;
}
