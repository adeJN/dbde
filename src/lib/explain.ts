import type { Driver, ExplainOutput } from "../types";
import { SQL_TOKENS } from "./sql";

// ---------------------------------------------------------------------------
// Statement selection. Explain works on exactly one statement: the selection, or
// the statement under the cursor. The backend validates again (explain.rs).
// ---------------------------------------------------------------------------

/** Blanks comments, strings and quoted identifiers, keeping every offset intact. */
export function maskSql(sql: string, driver: Driver): string {
  return sql.replace(SQL_TOKENS[driver], (token) => " ".repeat(token.length));
}
export interface StatementRange {
  start: number;
  end: number;
  text: string;
}
/** Non-empty statements with their offsets (without the separating semicolon). */
export function splitStatements(sql: string, driver: Driver): StatementRange[] {
  const masked = maskSql(sql, driver);
  const ranges: StatementRange[] = [];
  let start = 0;
  for (let index = 0; index <= masked.length; index++) {
    if (index < masked.length && masked[index] !== ";") continue;
    const segment = masked.slice(start, index);
    if (segment.trim()) {
      const lead = segment.length - segment.trimStart().length;
      const trail = segment.length - segment.trimEnd().length;
      ranges.push({
        start: start + lead,
        end: index - trail,
        text: sql.slice(start + lead, index - trail),
      });
    }
    start = index + 1;
  }
  return ranges;
}
const EXPLAINABLE: Record<Driver, string[]> = {
  postgres: [
    "SELECT",
    "WITH",
    "VALUES",
    "TABLE",
    "INSERT",
    "UPDATE",
    "DELETE",
    "MERGE",
  ],
  mysql: [
    "SELECT",
    "WITH",
    "VALUES",
    "TABLE",
    "INSERT",
    "UPDATE",
    "DELETE",
    "REPLACE",
  ],
  sqlite: ["SELECT", "WITH", "VALUES", "INSERT", "UPDATE", "DELETE", "REPLACE"],
};
function firstKeyword(masked: string) {
  return /^[\s(]*([A-Za-z]+)/.exec(masked)?.[1]?.toUpperCase() ?? "";
}
/** Why a single statement cannot be explained, or undefined when it can. */
export function explainStatementError(
  statement: string,
  driver: Driver,
): string | undefined {
  const masked = maskSql(statement, driver);
  if (!masked.trim()) return "There is no statement to explain.";
  if (/;\s*\S/.test(masked.replace(/;\s*$/, "")))
    return "Explain one statement at a time. Select a single statement or place the cursor inside it.";
  const keyword = firstKeyword(masked);
  if (["EXPLAIN", "ANALYZE", "DESCRIBE", "DESC"].includes(keyword))
    return "Remove EXPLAIN/ANALYZE from the statement; DBde adds it.";
  if (!EXPLAINABLE[driver].includes(keyword))
    return `Only ${EXPLAINABLE[driver].join(", ")} statements can be explained.`;
  return undefined;
}
/**
 * The statement to explain: the selected text (which must hold one statement), or the
 * statement containing the cursor. With no editor position, the whole text must be one
 * statement.
 */
export function explainTarget(
  sql: string,
  driver: Driver,
  selection?: { start: number; end: number },
  cursor?: number,
): { statement: string } | { error: string } {
  let statement: string | undefined;
  if (selection && selection.end > selection.start) {
    const parts = splitStatements(
      sql.slice(selection.start, selection.end),
      driver,
    );
    if (parts.length > 1)
      return {
        error:
          "The selection contains several statements. Select only one statement to explain.",
      };
    statement = parts[0]?.text;
  } else {
    const parts = splitStatements(sql, driver);
    if (cursor === undefined) {
      if (parts.length > 1)
        return {
          error:
            "The editor contains several statements. Place the cursor in one statement or select it.",
        };
      statement = parts[0]?.text;
    } else {
      // The cursor right after a statement's semicolon still belongs to it.
      statement = (
        parts.find((part) => cursor >= part.start && cursor <= part.end + 1) ??
        parts.filter((part) => part.end <= cursor).at(-1) ??
        parts[0]
      )?.text;
    }
  }
  if (!statement?.trim()) return { error: "There is no statement to explain." };
  const error = explainStatementError(statement, driver);
  return error ? { error } : { statement: statement.trim() };
}
/** SELECT/WITH/VALUES/TABLE without data-changing keywords (mirrors explain.rs). */
export function isReadOnlyStatement(statement: string, driver: Driver) {
  const masked = maskSql(statement, driver);
  return (
    ["SELECT", "WITH", "VALUES", "TABLE"].includes(firstKeyword(masked)) &&
    !/\b(INSERT|UPDATE|DELETE|MERGE|INTO)\b/i.test(masked)
  );
}
/** The statement the backend runs, for confirmations (mirrors explain.rs). */
export function explainSql(
  statement: string,
  driver: Driver,
  analyze: boolean,
): string {
  const text = statement.trim().replace(/;+\s*$/, "");
  if (driver === "postgres")
    return `${analyze ? "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)" : "EXPLAIN (FORMAT JSON)"} ${text}`;
  if (driver === "mysql")
    return `${analyze ? "ANALYZE FORMAT=JSON" : "EXPLAIN FORMAT=JSON"} ${text}`;
  return `EXPLAIN QUERY PLAN ${text}`;
}

// ---------------------------------------------------------------------------
// JSON that keeps duplicate keys. MariaDB writes several "table" members in one
// object (e.g. inside "temporary_table"); JSON.parse would silently drop all but one.
// ---------------------------------------------------------------------------

export type JsonValue =
  null | boolean | number | string | JsonValue[] | JsonObject;
export class JsonObject {
  constructor(readonly entries: [string, JsonValue][]) {}
  get(key: string): JsonValue | undefined {
    return this.entries.find(([name]) => name === key)?.[1];
  }
}
export function parseJsonKeepingDuplicates(text: string): JsonValue {
  let index = 0;
  const fail = (what: string): never => {
    throw new Error(`Invalid plan JSON near character ${index}: ${what}`);
  };
  const space = () => {
    while (index < text.length && " \t\r\n".includes(text[index])) index++;
  };
  const stringToken = /"(?:[^"\\]|\\.)*"/y;
  const numberToken = /-?\d+(?:\.\d+)?(?:[eE][+-]?\d+)?/y;
  function string(): string {
    stringToken.lastIndex = index;
    const match = stringToken.exec(text) ?? fail("unterminated string");
    index = stringToken.lastIndex;
    return JSON.parse(match[0]) as string;
  }
  function value(depth: number): JsonValue {
    if (depth > 500) fail("nesting too deep");
    space();
    const char = text[index];
    if (char === "{") {
      index++;
      const entries: [string, JsonValue][] = [];
      space();
      if (text[index] === "}") {
        index++;
        return new JsonObject(entries);
      }
      for (;;) {
        space();
        if (text[index] !== '"') fail("expected a member name");
        const key = string();
        space();
        if (text[index++] !== ":") fail("expected ':'");
        entries.push([key, value(depth + 1)]);
        space();
        const next = text[index++];
        if (next === "}") return new JsonObject(entries);
        if (next !== ",") fail("expected ',' or '}'");
      }
    }
    if (char === "[") {
      index++;
      const items: JsonValue[] = [];
      space();
      if (text[index] === "]") {
        index++;
        return items;
      }
      for (;;) {
        items.push(value(depth + 1));
        space();
        const next = text[index++];
        if (next === "]") return items;
        if (next !== ",") fail("expected ',' or ']'");
      }
    }
    if (char === '"') return string();
    for (const [word, literal] of [
      ["true", true],
      ["false", false],
      ["null", null],
    ] as const)
      if (text.startsWith(word, index)) {
        index += word.length;
        return literal;
      }
    numberToken.lastIndex = index;
    const number = numberToken.exec(text) ?? fail("unexpected character");
    index = numberToken.lastIndex;
    return Number(number[0]);
  }
  const result = value(0);
  space();
  if (index < text.length) fail("unexpected trailing text");
  return result;
}

// ---------------------------------------------------------------------------
// Normalised plan tree.
// ---------------------------------------------------------------------------

export interface PlanNode {
  id: string;
  operation: string;
  /** Table, relation or other object the node reads. */
  object?: string;
  index?: string;
  condition?: string;
  /** Rows the planner expected (per loop for PostgreSQL and MySQL TREE). */
  estimatedRows?: number;
  /** Rows actually produced (per loop where the server reports it that way). */
  actualRows?: number;
  loops?: number;
  /** Cost as reported by the server (PostgreSQL/MySQL TREE: cumulative). */
  cost?: number;
  /** Inclusive actual time in ms across all loops. */
  time?: number;
  /** The node's own share of the metric (time when analyzed, else cost, else rows). */
  weight: number;
  /** weight / sum of all weights. */
  share: number;
  expensive: boolean;
  warnings: string[];
  details: [string, string][];
  children: PlanNode[];
}
export type PlanMetric = "time" | "cost" | "rows";
export interface ParsedPlan {
  source: "postgres" | "mysql-json" | "mysql-tree" | "mysql-table" | "sqlite";
  roots: PlanNode[];
  analyzed: boolean;
  metric?: PlanMetric;
  /** One line per warning node, e.g. "Full table scan on orders". */
  warnings: string[];
  planningMs?: number;
  executionMs?: number;
  totalCost?: number;
  /** Tabular plan output (MySQL classic EXPLAIN, SQLite EXPLAIN QUERY PLAN). */
  grid?: { columns: string[]; rows: unknown[][] };
  /** Text for the Raw view and Copy. */
  raw: string;
}
type Draft = Omit<
  PlanNode,
  "id" | "weight" | "share" | "expensive" | "children"
> & {
  children: Draft[];
  /** Own weight before normalisation; computed from children when undefined. */
  selfWeight?: number;
};
function draft(operation: string, extra: Partial<Draft> = {}): Draft {
  return { operation, warnings: [], details: [], children: [], ...extra };
}
function toNumber(value: unknown): number | undefined {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value === "string" && value.trim() && Number.isFinite(+value))
    return +value;
  return undefined;
}
function text(value: unknown): string {
  if (value == null) return "";
  if (Array.isArray(value)) return value.map(text).join(", ");
  if (value instanceof JsonObject)
    return value.entries.map(([k, v]) => `${k}: ${text(v)}`).join("; ");
  if (typeof value === "object") return JSON.stringify(value);
  return String(value);
}
const FULL_SCAN = "Full table scan";

// PostgreSQL: [{ "Plan": {...}, "Planning Time", "Execution Time" }]
const PG_SHOWN = new Set([
  "Node Type",
  "Relation Name",
  "Schema",
  "Alias",
  "Index Name",
  "Plan Rows",
  "Actual Rows",
  "Actual Loops",
  "Total Cost",
  "Actual Total Time",
  "Plans",
  "Index Cond",
  "Filter",
  "Hash Cond",
  "Merge Cond",
  "Join Filter",
  "Recheck Cond",
  "Operation",
  "Parallel Aware",
  "Async Capable",
]);
function pgNode(plan: Record<string, unknown>, analyzed: boolean): Draft {
  const type = String(plan["Node Type"] ?? "Plan");
  const relation = plan["Relation Name"] as string | undefined;
  const alias = plan["Alias"] as string | undefined;
  const object = relation
    ? `${plan["Schema"] ? `${plan["Schema"]}.` : ""}${relation}${alias && alias !== relation ? ` ${alias}` : ""}`
    : ((plan["CTE Name"] ?? plan["Function Name"] ?? alias) as
        string | undefined);
  const loops = toNumber(plan["Actual Loops"]);
  const perLoop = toNumber(plan["Actual Total Time"]);
  const node = draft(
    plan["Operation"] ? `${type} (${plan["Operation"]})` : type,
    {
      object,
      index: plan["Index Name"] as string | undefined,
      condition: [
        "Index Cond",
        "Hash Cond",
        "Merge Cond",
        "Recheck Cond",
        "Join Filter",
        "Filter",
      ]
        .map((key) => plan[key])
        .filter(Boolean)
        .map(String)
        .join(" · "),
      estimatedRows: toNumber(plan["Plan Rows"]),
      actualRows: toNumber(plan["Actual Rows"]),
      loops,
      cost: toNumber(plan["Total Cost"]),
      time: perLoop === undefined ? undefined : perLoop * (loops ?? 1),
    },
  );
  if (!node.condition) delete node.condition;
  for (const [key, value] of Object.entries(plan))
    if (!PG_SHOWN.has(key) && value !== null && typeof value !== "object")
      node.details.push([key, text(value)]);
    else if (!PG_SHOWN.has(key) && Array.isArray(value) && value.length)
      node.details.push([key, text(value)]);
  if (/^Seq Scan$|^Parallel Seq Scan$/.test(type))
    node.warnings.push(`${FULL_SCAN} on ${relation ?? object ?? "a table"}`);
  if (analyzed && loops === 0) node.warnings.push("Never executed");
  if (
    analyzed &&
    node.estimatedRows !== undefined &&
    node.actualRows !== undefined &&
    Math.max(node.estimatedRows, node.actualRows) >= 100
  ) {
    const ratio =
      Math.max(node.estimatedRows, node.actualRows) /
      Math.max(1, Math.min(node.estimatedRows, node.actualRows));
    if (ratio >= 10)
      node.warnings.push(
        `Row estimate off by ${Math.round(ratio)}× (${node.estimatedRows} expected, ${node.actualRows} actual)`,
      );
  }
  node.children = ((plan["Plans"] as Record<string, unknown>[]) ?? []).map(
    (child) => pgNode(child, analyzed),
  );
  return node;
}
export function parsePostgresPlan(
  raw: string,
  analyzed: boolean,
): Omit<ParsedPlan, "raw" | "grid"> {
  const document = JSON.parse(raw) as unknown;
  const top = (Array.isArray(document) ? document[0] : document) as
    Record<string, unknown> | undefined;
  const plan = top?.["Plan"] as Record<string, unknown> | undefined;
  if (!plan) throw new Error("The PostgreSQL plan has no Plan node.");
  const root = pgNode(plan, analyzed);
  return finish("postgres", [root], analyzed, analyzed ? "time" : "cost", {
    planningMs: toNumber(top?.["Planning Time"]),
    executionMs: toNumber(top?.["Execution Time"]),
    totalCost: root.cost,
  });
}

// MySQL / MariaDB FORMAT=JSON (and MariaDB ANALYZE FORMAT=JSON).
const MYSQL_ACCESS: Record<string, string> = {
  ALL: FULL_SCAN,
  index: "Full index scan",
  range: "Index range scan",
  ref: "Index lookup",
  eq_ref: "Unique index lookup",
  ref_or_null: "Index lookup (or NULL)",
  const: "Constant row",
  system: "System row",
  fulltext: "Full-text index",
  index_merge: "Index merge",
  unique_subquery: "Unique subquery",
  index_subquery: "Index subquery",
  hash: "Hash join",
};
const MYSQL_WRAPPERS: Record<string, string> = {
  query_block: "Query block",
  nested_loop: "Nested loop",
  ordering_operation: "Order",
  grouping_operation: "Group",
  duplicates_removal: "Distinct",
  union_result: "Union result",
  filesort: "Filesort",
  temporary_table: "Temporary table",
  read_sorted_file: "Read sorted file",
  "block-nl-join": "Block nested loop join",
  materialized_from_subquery: "Materialized subquery",
  materialized: "Materialized",
  windowing: "Window",
  buffer_result: "Buffer result",
  query_specifications: "Query specifications",
  attached_subqueries: "Subqueries",
  having_subqueries: "HAVING subqueries",
  select_list_subqueries: "Select-list subqueries",
  order_by_subqueries: "ORDER BY subqueries",
  group_by_subqueries: "GROUP BY subqueries",
  optimized_away_subqueries: "Optimized away subqueries",
  subqueries: "Subqueries",
  expression_cache: "Expression cache",
  "range-checked-for-each-record": "Range checked for each record",
};
const isContainer = (value: JsonValue | undefined) =>
  value instanceof JsonObject ||
  (Array.isArray(value) && value.some((item) => typeof item === "object"));
function mysqlTable(object: JsonObject): Draft {
  const access = text(object.get("access_type"));
  const name = text(object.get("table_name")) || undefined;
  const costs = object.get("cost_info");
  const cost =
    costs instanceof JsonObject
      ? (toNumber(costs.get("read_cost")) ?? 0) +
        (toNumber(costs.get("eval_cost")) ?? 0)
      : undefined;
  const loops = toNumber(object.get("r_loops"));
  const node = draft(MYSQL_ACCESS[access] ?? (access || "Table"), {
    object: name,
    index: text(object.get("key")) || undefined,
    condition: text(object.get("attached_condition")) || undefined,
    estimatedRows:
      toNumber(object.get("rows_examined_per_scan")) ??
      toNumber(object.get("rows")),
    actualRows: toNumber(object.get("r_rows")),
    loops,
    cost: costs instanceof JsonObject && cost ? cost : undefined,
    time: toNumber(object.get("r_total_time_ms")),
  });
  if (access === "ALL")
    node.warnings.push(`${FULL_SCAN} on ${name ?? "a table"}`);
  if (object.get("update") !== undefined)
    node.operation = `${node.operation} (update)`;
  if (object.get("delete") !== undefined)
    node.operation = `${node.operation} (delete)`;
  for (const [key, value] of object.entries) {
    if (
      [
        "table_name",
        "access_type",
        "key",
        "attached_condition",
        "rows",
        "rows_examined_per_scan",
        "r_rows",
        "r_loops",
        "r_total_time_ms",
        "cost_info",
      ].includes(key) ||
      isContainer(value)
    )
      continue;
    node.details.push([key, text(value)]);
  }
  if (costs instanceof JsonObject)
    for (const [key, value] of costs.entries)
      node.details.push([`cost_info.${key}`, text(value)]);
  node.children = object.entries
    .filter(([, value]) => isContainer(value))
    .flatMap(([key, value]) => mysqlWalk(key, value));
  return node;
}
function mysqlWalk(key: string, value: JsonValue): Draft[] {
  if (Array.isArray(value)) {
    const items = value.flatMap((item) =>
      item instanceof JsonObject
        ? item.get("table_name") !== undefined
          ? [mysqlTable(item)]
          : item.entries.flatMap(([k, v]) => mysqlWalk(k, v))
        : [],
    );
    if (key === "nested_loop" || !MYSQL_WRAPPERS[key]) return items;
    const node = draft(MYSQL_WRAPPERS[key]);
    node.children = items;
    return [node];
  }
  if (!(value instanceof JsonObject)) return [];
  if (key === "table" || value.get("table_name") !== undefined)
    return [mysqlTable(value)];
  const label = MYSQL_WRAPPERS[key] ?? key.replace(/[_-]/g, " ");
  const selectId = value.get("select_id");
  const node = draft(
    key === "query_block" && selectId !== undefined
      ? `Select #${text(selectId)}`
      : label,
  );
  const costs = value.get("cost_info");
  if (costs instanceof JsonObject) {
    node.cost = toNumber(costs.get("query_cost") ?? costs.get("sort_cost"));
    for (const [name, cost] of costs.entries)
      node.details.push([`cost_info.${name}`, text(cost)]);
  }
  node.loops = toNumber(value.get("r_loops"));
  node.time = toNumber(value.get("r_total_time_ms"));
  node.actualRows = toNumber(value.get("r_output_rows"));
  const message = value.get("message");
  if (typeof message === "string") node.operation = `${label}: ${message}`;
  for (const [name, item] of value.entries) {
    if (
      isContainer(item) ||
      [
        "cost_info",
        "r_loops",
        "r_total_time_ms",
        "r_output_rows",
        "message",
      ].includes(name)
    )
      continue;
    node.details.push([name, text(item)]);
  }
  if (value.get("using_filesort") === true)
    node.details.push(["Sort", "Filesort"]);
  if (value.get("using_temporary_table") === true)
    node.details.push(["Temporary", "Uses a temporary table"]);
  node.children = value.entries
    .filter(([name, item]) => name !== "cost_info" && isContainer(item))
    .flatMap(([name, item]) => mysqlWalk(name, item));
  // query_block times include everything below; other MariaDB timings are their own.
  if (key !== "query_block") node.selfWeight = node.time ?? 0;
  return [node];
}
export function parseMysqlJsonPlan(
  raw: string,
  analyzed: boolean,
): Omit<ParsedPlan, "raw" | "grid"> {
  const document = parseJsonKeepingDuplicates(raw);
  if (!(document instanceof JsonObject))
    throw new Error("The MySQL plan is not a JSON object.");
  const roots = document.entries.flatMap(([key, value]) =>
    mysqlWalk(key, value),
  );
  const timed = analyzed && hasField(roots, "time");
  const costed = hasField(roots, "cost");
  const root = roots[0];
  return finish(
    "mysql-json",
    roots,
    analyzed,
    timed ? "time" : costed ? "cost" : "rows",
    { totalCost: root?.cost, executionMs: analyzed ? root?.time : undefined },
  );
}
function hasField(nodes: Draft[], field: "time" | "cost"): boolean {
  return nodes.some(
    (node) =>
      (field === "cost"
        ? node.cost !== undefined && node.object !== undefined
        : node.time !== undefined) || hasField(node.children, field),
  );
}

// MySQL 8 EXPLAIN ANALYZE / FORMAT=TREE text.
export function parseMysqlTreePlan(
  raw: string,
  analyzed: boolean,
): Omit<ParsedPlan, "raw" | "grid"> {
  const roots: Draft[] = [];
  const stack: { level: number; node: Draft }[] = [];
  for (const line of raw.split(/\r?\n/)) {
    const match = /^(\s*)-> (.*)$/.exec(line);
    if (!match) {
      // Continuation lines belong to the previous node's description.
      if (line.trim() && stack.length)
        stack[stack.length - 1].node.operation += ` ${line.trim()}`;
      continue;
    }
    const level = match[1].length;
    let body = match[2];
    const node = draft("");
    const estimate =
      /\(cost=([\d.e+-]+)(?:\.\.([\d.e+-]+))? rows=([\d.e+-]+)\)/.exec(body);
    if (estimate) {
      node.cost = toNumber(estimate[2] ?? estimate[1]);
      node.estimatedRows = toNumber(estimate[3]);
    }
    const actual =
      /\(actual time=([\d.e+-]+)\.\.([\d.e+-]+) rows=([\d.e+-]+) loops=(\d+)\)/.exec(
        body,
      );
    if (actual) {
      node.loops = toNumber(actual[4]);
      node.actualRows = toNumber(actual[3]);
      node.time = (toNumber(actual[2]) ?? 0) * (node.loops ?? 1);
    }
    if (/\(never executed\)/.test(body)) {
      node.loops = 0;
      node.warnings.push("Never executed");
    }
    body = body
      .replace(/\s*\((?:cost|actual time)=[^)]*\)/g, "")
      .replace(/\s*\(never executed\)/, "")
      .trim();
    const object =
      /^(?:Table scan|Index scan|Index lookup|Single-row index lookup|Index range scan|Covering index lookup|Covering index scan|Index lookup|Full-text index search|Constant row from|Rows fetched before execution|Index range scan|Covering index range scan|Multi-range index range scan) on (\S+)/.exec(
        body,
      );
    if (object) node.object = object[1].replace(/`/g, "");
    const index = / using (\S+)/.exec(body);
    if (index && object) node.index = index[1].replace(/`/g, "");
    const filter = /^Filter: (.*)$/.exec(body);
    if (filter) {
      node.operation = "Filter";
      node.condition = filter[1];
    } else node.operation = body;
    if (/^Table scan on /.test(body) && !/^Table scan on </.test(body))
      node.warnings.unshift(`${FULL_SCAN} on ${node.object}`);
    while (stack.length && stack[stack.length - 1].level >= level) stack.pop();
    if (stack.length) stack[stack.length - 1].node.children.push(node);
    else roots.push(node);
    stack.push({ level, node });
  }
  if (!roots.length) throw new Error("The MySQL plan tree is empty.");
  return finish(
    "mysql-tree",
    roots,
    analyzed,
    hasField(roots, "time") ? "time" : "cost",
    { totalCost: roots[0].cost, executionMs: roots[0].time },
  );
}

// MySQL classic tabular EXPLAIN.
function cell(columns: string[], row: unknown[], name: string) {
  const index = columns.findIndex(
    (column) => column.toLowerCase() === name.toLowerCase(),
  );
  const value = index < 0 ? undefined : row[index];
  return value == null || value === "NULL" ? undefined : value;
}
export function parseMysqlTablePlan(
  columns: string[],
  rows: unknown[][],
): Omit<ParsedPlan, "raw" | "grid"> {
  const groups = new Map<string, Draft>();
  const roots: Draft[] = [];
  for (const row of rows) {
    const id = text(cell(columns, row, "id")) || "?";
    let group = groups.get(id);
    if (!group) {
      group = draft(
        `Select #${id}${cell(columns, row, "select_type") ? ` (${text(cell(columns, row, "select_type"))})` : ""}`,
      );
      groups.set(id, group);
      roots.push(group);
    }
    const access = text(cell(columns, row, "type"));
    const table = text(cell(columns, row, "table")) || undefined;
    const node = draft(MYSQL_ACCESS[access] ?? (access || "Row"), {
      object: table,
      index: text(cell(columns, row, "key")) || undefined,
      estimatedRows: toNumber(cell(columns, row, "rows")),
    });
    node.selfWeight = node.estimatedRows ?? 0;
    for (const name of ["possible_keys", "key_len", "ref", "filtered", "Extra"])
      if (
        cell(columns, row, name) !== undefined &&
        text(cell(columns, row, name))
      )
        node.details.push([name, text(cell(columns, row, name))]);
    if (access === "ALL")
      node.warnings.push(`${FULL_SCAN} on ${table ?? "a table"}`);
    group.children.push(node);
  }
  return finish("mysql-table", roots, false, "rows", {});
}

// SQLite EXPLAIN QUERY PLAN: id, parent, notused, detail.
export function parseSqlitePlan(
  columns: string[],
  rows: unknown[][],
): Omit<ParsedPlan, "raw" | "grid"> {
  const nodes = new Map<string, Draft>();
  const roots: Draft[] = [];
  for (const row of rows) {
    const detail = text(cell(columns, row, "detail"));
    const node = draft(detail);
    const scan = /^(SCAN|SEARCH) (?:TABLE )?(\S+)/.exec(detail);
    if (scan && !scan[2].startsWith("(")) node.object = scan[2];
    const index = /USING (?:COVERING )?INDEX (\S+)/.exec(detail);
    if (index) node.index = index[1];
    else if (/USING INTEGER PRIMARY KEY/.test(detail))
      node.index = "INTEGER PRIMARY KEY";
    if (
      scan?.[1] === "SCAN" &&
      node.object &&
      !/\bUSING\b|VIRTUAL TABLE|CONSTANT ROW/.test(detail)
    )
      node.warnings.push(`${FULL_SCAN} on ${node.object}`);
    nodes.set(text(cell(columns, row, "id")), node);
    const parent = nodes.get(text(cell(columns, row, "parent")));
    if (parent) parent.children.push(node);
    else roots.push(node);
  }
  return finish("sqlite", roots, false, undefined, {});
}

// Weights, shares, ids and the warning summary.
function finish(
  source: ParsedPlan["source"],
  drafts: Draft[],
  analyzed: boolean,
  metric: PlanMetric | undefined,
  totals: Pick<ParsedPlan, "planningMs" | "executionMs" | "totalCost">,
): Omit<ParsedPlan, "raw" | "grid"> {
  const warnings: string[] = [];
  const all: PlanNode[] = [];
  const value = (node: Draft) =>
    metric === "time"
      ? node.time
      : metric === "cost"
        ? node.cost
        : node.estimatedRows;
  function own(item: Draft, children: PlanNode[]): number {
    if (!metric) return 0;
    switch (source) {
      // Inclusive figures: subtract what the children account for.
      case "postgres":
      case "mysql-tree":
        return Math.max(
          0,
          (value(item) ?? 0) -
            item.children.reduce((sum, child) => sum + (value(child) ?? 0), 0),
        );
      case "mysql-table":
        return item.selfWeight ?? 0;
      case "mysql-json":
        // Tables carry their own read+eval cost, row estimate or r_total_time_ms.
        if (item.object !== undefined) return value(item) ?? 0;
        if (metric !== "time") return 0;
        // MariaDB wrappers (filesort…) time themselves; query blocks include everything.
        if (item.selfWeight !== undefined) return item.selfWeight;
        return Math.max(
          0,
          (item.time ?? 0) -
            children.reduce(
              (sum, child) => sum + child.weight + descendants(child),
              0,
            ),
        );
      default:
        return 0;
    }
  }
  function build(item: Draft, id: string): PlanNode {
    const children = item.children.map((child, index) =>
      build(child, `${id}.${index}`),
    );
    const weight = own(item, children);
    const { selfWeight: _ignored, ...rest } = item;
    void _ignored;
    const node: PlanNode = {
      ...rest,
      id,
      weight,
      share: 0,
      expensive: false,
      children,
    };
    for (const warning of node.warnings)
      if (warning.startsWith(FULL_SCAN)) warnings.push(warning);
    all.push(node);
    return node;
  }
  const roots = drafts.map((item, index) => build(item, String(index)));
  const total = all.reduce((sum, node) => sum + node.weight, 0);
  const max = Math.max(0, ...all.map((node) => node.weight));
  for (const node of all) {
    node.share = total > 0 ? node.weight / total : 0;
    node.expensive =
      total > 0 &&
      node.weight > 0 &&
      (node.share >= 0.25 || node.weight === max);
  }
  return {
    source,
    roots,
    analyzed,
    metric,
    warnings: [...new Set(warnings)],
    ...totals,
  };
}
function descendants(node: PlanNode): number {
  return node.children.reduce(
    (sum, child) => sum + child.weight + descendants(child),
    0,
  );
}
function tabularText(columns: string[], rows: unknown[][]) {
  return [columns, ...rows]
    .map((row) =>
      row.map((value) => (value == null ? "NULL" : text(value))).join("\t"),
    )
    .join("\n");
}
/** Normalises any driver's EXPLAIN output into one tree. */
export function parsePlan(output: ExplainOutput, driver: Driver): ParsedPlan {
  const grid = output.columns.length
    ? { columns: output.columns, rows: output.rows }
    : undefined;
  const raw =
    output.format === "table"
      ? tabularText(output.columns, output.rows)
      : output.raw;
  let parsed: Omit<ParsedPlan, "raw" | "grid">;
  if (driver === "postgres")
    parsed = parsePostgresPlan(output.raw, output.analyzed);
  else if (driver === "sqlite")
    parsed = parseSqlitePlan(output.columns, output.rows);
  else if (output.format === "tree")
    parsed = parseMysqlTreePlan(output.raw, output.analyzed);
  else if (output.format === "json")
    parsed = parseMysqlJsonPlan(output.raw, output.analyzed);
  else parsed = parseMysqlTablePlan(output.columns, output.rows);
  // MySQL's tabular EXPLAIN also reports full scans that JSON may hide in wrappers.
  return { ...parsed, grid, raw };
}
/** Every node in display order with its depth. */
export function flattenPlan(
  roots: PlanNode[],
): { node: PlanNode; depth: number }[] {
  const out: { node: PlanNode; depth: number }[] = [];
  const visit = (node: PlanNode, depth: number) => {
    out.push({ node, depth });
    node.children.forEach((child) => visit(child, depth + 1));
  };
  roots.forEach((root) => visit(root, 0));
  return out;
}
