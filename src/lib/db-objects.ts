import type { DbObject, Driver, ObjectKind } from "../types";
import { quoteIdentifier } from "./sql";

/** Object kinds each driver has, in Navicat's order. Unsupported kinds are not shown. */
export function objectKinds(driver: Driver): ObjectKind[] {
  if (driver === "postgres")
    return [
      "function",
      "procedure",
      "trigger",
      "sequence",
      "materialized_view",
    ];
  if (driver === "mysql") return ["function", "procedure", "trigger", "event"];
  return ["trigger"];
}
export const OBJECT_LABELS: Record<ObjectKind, { one: string; many: string }> =
  {
    function: { one: "Function", many: "Functions" },
    procedure: { one: "Procedure", many: "Procedures" },
    trigger: { one: "Trigger", many: "Triggers" },
    event: { one: "Event", many: "Events" },
    sequence: { one: "Sequence", many: "Sequences" },
    materialized_view: { one: "Materialized View", many: "Materialized Views" },
  };
/** Identity of an object within a database: overloads and per-table triggers differ. */
export function objectKey(object: DbObject) {
  return JSON.stringify([
    object.kind,
    object.schema,
    object.table ?? "",
    object.name,
    object.signature ?? "",
  ]);
}
/** "f(integer, text)" for PostgreSQL routines, the bare name otherwise. */
export function objectLabel(object: DbObject) {
  return object.signature !== undefined &&
    (object.kind === "function" || object.kind === "procedure")
    ? `${object.name}(${object.signature})`
    : object.name;
}
/** Name for Copy name: schema-qualified and quoted, as it would be written in SQL. */
export function objectSqlName(object: DbObject, driver: Driver) {
  const name = quoteIdentifier(object.name, driver);
  return object.schema && driver === "postgres"
    ? `${quoteIdentifier(object.schema, driver)}.${name}`
    : name;
}
export function matchesObject(object: DbObject, term: string) {
  if (!term) return true;
  return [object.name, object.schema, object.table ?? "", object.detail ?? ""]
    .join("\n")
    .toLowerCase()
    .includes(term);
}
/** Whether "Execute" can call the object directly. */
export function executable(object: DbObject, driver: Driver) {
  return (
    driver === "postgres" &&
    (object.kind === "function" || object.kind === "procedure") &&
    object.flag !== "trigger"
  );
}
/** A starting point for New…, per kind and driver. Placeholders are plain SQL to edit. */
export function newObjectTemplate(
  kind: ObjectKind,
  driver: Driver,
  schema = driver === "postgres" ? "public" : "",
): string {
  const q = (name: string) => quoteIdentifier(name, driver);
  const scoped = (name: string) =>
    driver === "postgres" && schema ? `${q(schema)}.${q(name)}` : q(name);
  if (driver === "postgres") {
    switch (kind) {
      case "function":
        return `CREATE OR REPLACE FUNCTION ${scoped("new_function")}(a integer, b integer)\nRETURNS integer\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RETURN a + b;\nEND;\n$$;\n`;
      case "procedure":
        return `CREATE OR REPLACE PROCEDURE ${scoped("new_procedure")}(IN amount integer)\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  RAISE NOTICE 'amount: %', amount;\nEND;\n$$;\n`;
      case "trigger":
        return `-- A trigger calls a trigger function. Create the function first.\nCREATE OR REPLACE FUNCTION ${scoped("set_updated_at")}()\nRETURNS trigger\nLANGUAGE plpgsql\nAS $$\nBEGIN\n  NEW.updated_at := now();\n  RETURN NEW;\nEND;\n$$;\n\nCREATE TRIGGER ${q("new_trigger")}\nBEFORE UPDATE ON ${scoped("table_name")}\nFOR EACH ROW\nEXECUTE FUNCTION ${scoped("set_updated_at")}();\n`;
      case "sequence":
        return `CREATE SEQUENCE ${scoped("new_sequence")}\n  AS bigint\n  INCREMENT BY 1\n  START WITH 1\n  NO CYCLE;\n`;
      case "materialized_view":
        return `CREATE MATERIALIZED VIEW ${scoped("new_materialized_view")} AS\nSELECT 1 AS id\nWITH DATA;\n\n-- A unique index allows REFRESH MATERIALIZED VIEW CONCURRENTLY.\nCREATE UNIQUE INDEX ON ${scoped("new_materialized_view")} (id);\n`;
      default:
        break;
    }
  }
  if (driver === "mysql") {
    // DBde sends the whole script in one call, so bodies need no DELIMITER lines.
    switch (kind) {
      case "function":
        return `CREATE FUNCTION ${q("new_function")}(a INT, b INT)\nRETURNS INT\nDETERMINISTIC\nBEGIN\n  RETURN a + b;\nEND;\n`;
      case "procedure":
        return `CREATE PROCEDURE ${q("new_procedure")}(IN amount INT)\nBEGIN\n  SELECT amount;\nEND;\n`;
      case "trigger":
        return `CREATE TRIGGER ${q("new_trigger")}\nBEFORE INSERT ON ${q("table_name")}\nFOR EACH ROW\nBEGIN\n  SET NEW.created_at = COALESCE(NEW.created_at, NOW());\nEND;\n`;
      case "event":
        return `-- Events run only while the event scheduler is ON (SET GLOBAL event_scheduler = ON).\nCREATE EVENT ${q("new_event")}\nON SCHEDULE EVERY 1 DAY\nSTARTS CURRENT_TIMESTAMP\nDO\nBEGIN\n  DELETE FROM ${q("table_name")} WHERE created_at < NOW() - INTERVAL 30 DAY;\nEND;\n`;
      default:
        break;
    }
  }
  if (driver === "sqlite" && kind === "trigger")
    return `CREATE TRIGGER ${q("new_trigger")}\nAFTER INSERT ON ${q("table_name")}\nFOR EACH ROW\nBEGIN\n  SELECT 1;\nEND;\n`;
  throw new Error(
    `${OBJECT_LABELS[kind].many} are not available for this database.`,
  );
}
/** "BEFORE INSERT" from a SQLite CREATE TRIGGER statement (mirrors the backend). */
export function sqliteTriggerTiming(sql: string) {
  const words = sql
    .toUpperCase()
    .split(/[\s();]+/)
    .filter(Boolean);
  const event = words.findIndex((word) =>
    ["INSERT", "UPDATE", "DELETE"].includes(word),
  );
  if (event < 0) return "";
  const timing = words
    .slice(0, event)
    .reverse()
    .find((word) => ["BEFORE", "AFTER", "OF", "INSTEAD"].includes(word));
  return `${timing === "AFTER" ? "AFTER" : timing === "OF" || timing === "INSTEAD" ? "INSTEAD OF" : "BEFORE"} ${words[event]}`;
}
