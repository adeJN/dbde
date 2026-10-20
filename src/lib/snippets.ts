/**
 * Code snippets: SQL templates with Monaco snippet placeholders (`${1:table}`,
 * `$0`, `${1|a,b|}`). Built-in snippets ship per driver; user snippets are stored
 * like saved queries and apply to every driver unless limited.
 */
import type { Driver } from "../types";

export interface Snippet {
  id: string;
  name: string;
  /** Typing this in the SQL editor offers the snippet. */
  prefix: string;
  body: string;
  description?: string;
  /** Drivers the snippet applies to; empty or missing means all. */
  drivers?: Driver[];
  builtin?: boolean;
}
export const MAX_SNIPPET_BODY = 64 * 1024;
const DRIVERS: Driver[] = ["postgres", "mysql", "sqlite"];

const builtin = (
  id: string,
  name: string,
  prefix: string,
  body: string,
  drivers?: Driver[],
): Snippet => ({
  id: `builtin:${id}`,
  name,
  prefix,
  body,
  drivers,
  builtin: true,
});

export const BUILTIN_SNIPPETS: Snippet[] = [
  builtin(
    "select",
    "SELECT rows",
    "sel",
    "SELECT ${2:*}\nFROM ${1:table}\nWHERE ${3:condition}\nLIMIT ${4:100};$0",
  ),
  builtin(
    "insert",
    "INSERT row",
    "ins",
    "INSERT INTO ${1:table} (${2:column})\nVALUES (${3:value});$0",
  ),
  builtin(
    "update",
    "UPDATE rows",
    "upd",
    "UPDATE ${1:table}\nSET ${2:column} = ${3:value}\nWHERE ${4:condition};$0",
  ),
  builtin(
    "delete",
    "DELETE rows",
    "del",
    "DELETE FROM ${1:table}\nWHERE ${2:condition};$0",
  ),
  builtin(
    "join",
    "SELECT with JOIN",
    "join",
    "SELECT ${3:a}.*, ${4:b}.*\nFROM ${1:table_a} ${3:a}\n${5|JOIN,LEFT JOIN,RIGHT JOIN|} ${2:table_b} ${4:b} ON ${4:b}.${6:a_id} = ${3:a}.${7:id};$0",
  ),
  builtin(
    "count-group",
    "COUNT by group",
    "grp",
    "SELECT ${2:column}, COUNT(*) AS total\nFROM ${1:table}\nGROUP BY ${2:column}\nORDER BY total DESC;$0",
  ),
  builtin(
    "cte",
    "Common table expression",
    "cte",
    "WITH ${1:cte_name} AS (\n  SELECT ${3:*}\n  FROM ${2:table}\n)\nSELECT *\nFROM ${1:cte_name};$0",
  ),
  builtin(
    "create-table-pg",
    "CREATE TABLE",
    "ct",
    "CREATE TABLE ${1:table_name} (\n  id BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,\n  ${2:name} ${3:TEXT} NOT NULL,\n  created_at TIMESTAMPTZ NOT NULL DEFAULT now()\n);$0",
    ["postgres"],
  ),
  builtin(
    "create-table-mysql",
    "CREATE TABLE",
    "ct",
    "CREATE TABLE ${1:table_name} (\n  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,\n  ${2:name} ${3:VARCHAR(255)} NOT NULL,\n  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP\n) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;$0",
    ["mysql"],
  ),
  builtin(
    "create-table-sqlite",
    "CREATE TABLE",
    "ct",
    "CREATE TABLE ${1:table_name} (\n  id INTEGER PRIMARY KEY AUTOINCREMENT,\n  ${2:name} ${3:TEXT} NOT NULL,\n  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP\n);$0",
    ["sqlite"],
  ),
  builtin(
    "create-index",
    "CREATE INDEX",
    "ci",
    "CREATE ${4|INDEX,UNIQUE INDEX|} ${3:idx_${1:table}_${2:column}}\nON ${1:table} (${2:column});$0",
  ),
  builtin("transaction", "Transaction block", "tx", "BEGIN;\n\n$0\n\nCOMMIT;", [
    "postgres",
    "sqlite",
  ]),
  builtin(
    "transaction-mysql",
    "Transaction block",
    "tx",
    "START TRANSACTION;\n\n$0\n\nCOMMIT;",
    ["mysql"],
  ),
  builtin(
    "upsert-pg",
    "Upsert (ON CONFLICT)",
    "ups",
    "INSERT INTO ${1:table} (${2:id}, ${3:column})\nVALUES (${4:1}, ${5:value})\nON CONFLICT (${2:id}) DO UPDATE\nSET ${3:column} = EXCLUDED.${3:column};$0",
    ["postgres"],
  ),
  builtin(
    "upsert-sqlite",
    "Upsert (ON CONFLICT)",
    "ups",
    "INSERT INTO ${1:table} (${2:id}, ${3:column})\nVALUES (${4:1}, ${5:value})\nON CONFLICT (${2:id}) DO UPDATE\nSET ${3:column} = excluded.${3:column};$0",
    ["sqlite"],
  ),
  builtin(
    "upsert-mysql",
    "Upsert (ON DUPLICATE KEY)",
    "ups",
    // VALUES() works on MySQL and MariaDB (MySQL 8.0.20+ also accepts a row alias).
    "INSERT INTO ${1:table} (${2:id}, ${3:column})\nVALUES (${4:1}, ${5:value})\nON DUPLICATE KEY UPDATE ${3:column} = VALUES(${3:column});$0",
    ["mysql"],
  ),
  builtin(
    "explain-analyze",
    "EXPLAIN ANALYZE",
    "exa",
    "EXPLAIN (ANALYZE, BUFFERS)\n${1:SELECT 1};$0",
    ["postgres"],
  ),
  builtin("explain-mysql", "EXPLAIN", "exp", "EXPLAIN ${1:SELECT 1};$0", [
    "mysql",
  ]),
  builtin(
    "explain-sqlite",
    "EXPLAIN QUERY PLAN",
    "exp",
    "EXPLAIN QUERY PLAN\n${1:SELECT 1};$0",
    ["sqlite"],
  ),
  builtin(
    "processlist",
    "SHOW PROCESSLIST",
    "proc",
    "SHOW FULL PROCESSLIST;$0",
    ["mysql"],
  ),
  builtin(
    "pg-activity",
    "Active sessions",
    "proc",
    "SELECT pid, usename, state, now() - query_start AS running_for, query\nFROM pg_stat_activity\nWHERE state <> 'idle'\nORDER BY running_for DESC;$0",
    ["postgres"],
  ),
  builtin(
    "table-sizes-pg",
    "Largest tables",
    "size",
    "SELECT relname AS table_name,\n  pg_size_pretty(pg_total_relation_size(relid)) AS total_size\nFROM pg_catalog.pg_statio_user_tables\nORDER BY pg_total_relation_size(relid) DESC\nLIMIT ${1:20};$0",
    ["postgres"],
  ),
  builtin(
    "table-sizes-mysql",
    "Largest tables",
    "size",
    "SELECT table_name,\n  ROUND((data_length + index_length) / 1024 / 1024, 2) AS size_mb\nFROM information_schema.tables\nWHERE table_schema = DATABASE()\nORDER BY size_mb DESC\nLIMIT ${1:20};$0",
    ["mysql"],
  ),
  builtin(
    "pragma-sqlite",
    "Table info (PRAGMA)",
    "pti",
    "PRAGMA table_info(${1:table});$0",
    ["sqlite"],
  ),
];

export function appliesTo(snippet: Snippet, driver: Driver) {
  return !snippet.drivers?.length || snippet.drivers.includes(driver);
}
/** User snippets first (they may override a built-in prefix), then built-ins. */
export function snippetsFor(driver: Driver, user: Snippet[]) {
  return [...user, ...BUILTIN_SNIPPETS].filter((s) => appliesTo(s, driver));
}

export function filterSnippets(snippets: Snippet[], text: string) {
  const words = text.toLowerCase().split(/\s+/).filter(Boolean);
  return snippets.filter((snippet) =>
    words.every((word) =>
      `${snippet.name}\n${snippet.prefix}\n${snippet.description ?? ""}\n${snippet.body}`
        .toLowerCase()
        .includes(word),
    ),
  );
}

/**
 * Plain text of a snippet: placeholders become their defaults (the first choice),
 * tabstops disappear and `\$` stays a literal dollar sign.
 */
export function expandSnippet(body: string): string {
  let out = "";
  let index = 0;
  while (index < body.length) {
    const char = body[index];
    if (
      char === "\\" &&
      index + 1 < body.length &&
      "$}\\".includes(body[index + 1])
    ) {
      out += body[index + 1];
      index += 2;
      continue;
    }
    if (char !== "$") {
      out += char;
      index++;
      continue;
    }
    const tabstop = /^\$(\d+)/.exec(body.slice(index));
    if (tabstop) {
      index += tabstop[0].length;
      continue;
    }
    if (body[index + 1] === "{") {
      const end = matchingBrace(body, index + 1);
      if (end > 0) {
        out += placeholderDefault(body.slice(index + 2, end));
        index = end + 1;
        continue;
      }
    }
    out += char;
    index++;
  }
  return out;
}
function matchingBrace(body: string, open: number) {
  let depth = 0;
  for (let i = open; i < body.length; i++) {
    if (body[i] === "\\") {
      i++;
      continue;
    }
    if (body[i] === "{") depth++;
    else if (body[i] === "}" && --depth === 0) return i;
  }
  return -1;
}
function placeholderDefault(inner: string): string {
  const choice = /^\d+\|([^]*)\|$/.exec(inner);
  if (choice) return choice[1].split(",")[0].replace(/\\(.)/g, "$1");
  const placeholder = /^\d+:([^]*)$/.exec(inner);
  if (placeholder) return expandSnippet(placeholder[1]);
  if (/^\d+$/.test(inner)) return "";
  return "";
}

export function snippetError(
  snippet: Pick<Snippet, "name" | "prefix" | "body">,
) {
  if (!snippet.name.trim()) return "Enter a name.";
  if (snippet.name.length > 120) return "Use a shorter name.";
  if (!/^[A-Za-z_]\w{0,39}$/.test(snippet.prefix))
    return "The prefix must start with a letter or _ and use only letters, digits or _ (max 40).";
  if (!snippet.body.trim()) return "Enter the snippet body.";
  if (snippet.body.length > MAX_SNIPPET_BODY) return "The body is too long.";
  return "";
}

export function isSnippet(value: unknown): value is Snippet {
  const item = value as Snippet;
  return (
    !!item &&
    typeof item === "object" &&
    typeof item.id === "string" &&
    typeof item.name === "string" &&
    typeof item.prefix === "string" &&
    typeof item.body === "string" &&
    (item.description === undefined || typeof item.description === "string") &&
    (item.drivers === undefined ||
      (Array.isArray(item.drivers) &&
        item.drivers.every((driver) => DRIVERS.includes(driver))))
  );
}
export function readSnippets(list: unknown): Snippet[] {
  if (!Array.isArray(list)) return [];
  return list
    .filter(isSnippet)
    .map((snippet) => ({ ...snippet, builtin: undefined }))
    .filter((snippet) => !snippet.id.startsWith("builtin:"));
}
