import type { Driver, TableInfo } from "../types";

export interface SqlRange {
  start: number;
  end: number;
  boundary: number;
  text: string;
}
export interface SqlIssue {
  offset: number;
  message: string;
}
export interface SqlAnalysis {
  statements: SqlRange[];
  issues: SqlIssue[];
  unsafe?: string;
  completionCode: string;
}
/** A lexical outline, not a SQL grammar validator. Never execute SQL to analyse it. */
export function analyseSql(sql: string, driver: Driver): SqlAnalysis {
  if (sql.length > 2_000_000)
    return {
      statements: [],
      issues: [],
      unsafe:
        "Statement analysis is limited to 2 MB. Select SQL explicitly or run the script.",
      completionCode: "",
    };
  const structure = sql.split(""),
    visible = sql.split(""),
    completion = sql.split("");
  const issues: SqlIssue[] = [];
  const blank = (
    start: number,
    end: number,
    kind: "comment" | "string" | "identifier",
  ) => {
    for (let j = start; j < end; j++) {
      if (sql[j] !== "\n" && sql[j] !== "\r") {
        structure[j] = " ";
        if (kind === "comment") visible[j] = " ";
        if (kind !== "identifier") completion[j] = " ";
      }
    }
  };
  let executableComment = false;
  let i = 0;
  while (i < sql.length) {
    const start = i,
      c = sql[i];
    if (
      (sql.startsWith("--", i) &&
        (driver !== "mysql" || !sql[i + 2] || /\s/.test(sql[i + 2]))) ||
      (driver === "mysql" && c === "#")
    ) {
      while (i < sql.length && sql[i] !== "\n") i++;
      blank(start, i, "comment");
      continue;
    }
    if (sql.startsWith("/*", i)) {
      if (
        driver === "mysql" &&
        (sql.startsWith("/*!", i) || sql.startsWith("/*M!", i))
      )
        executableComment = true;
      i += 2;
      let depth = 1;
      while (i < sql.length && depth) {
        if (driver === "postgres" && sql.startsWith("/*", i)) {
          depth++;
          i += 2;
        } else if (sql.startsWith("*/", i)) {
          depth--;
          i += 2;
        } else i++;
      }
      if (depth)
        issues.push({ offset: start, message: "Unclosed block comment" });
      blank(start, i, "comment");
      continue;
    }
    if (driver === "postgres" && c === "$") {
      const tag = /^\$(?:[A-Za-z_]\w*)?\$/.exec(sql.slice(i))?.[0];
      if (tag) {
        const end = sql.indexOf(tag, i + tag.length);
        i = end < 0 ? sql.length : end + tag.length;
        if (end < 0)
          issues.push({ offset: start, message: `Unclosed ${tag} string` });
        blank(start, i, "string");
        continue;
      }
    }
    const quoted =
      c === "'" || c === '"' || c === "`" || (driver === "sqlite" && c === "[");
    if (quoted) {
      const close = c === "[" ? "]" : c;
      const kind =
        c === "'" || (driver === "mysql" && c === '"')
          ? "string"
          : "identifier";
      const escaped =
        driver === "mysql" ||
        (driver === "postgres" &&
          c === "'" &&
          /[eE]/.test(sql[start - 1] ?? "") &&
          !/\w/.test(sql[start - 2] ?? ""));
      i++;
      let ended = false;
      while (i < sql.length) {
        if (escaped && sql[i] === "\\") {
          i = Math.min(sql.length, i + 2);
          continue;
        }
        if (sql[i] === close) {
          if (sql[i + 1] === close && c !== "[") {
            i += 2;
            continue;
          }
          i++;
          ended = true;
          break;
        }
        i++;
      }
      if (!ended)
        issues.push({
          offset: start,
          message:
            kind === "string"
              ? "Unclosed string literal"
              : "Unclosed quoted identifier",
        });
      blank(start, i, kind);
      continue;
    }
    i++;
  }
  const skeleton = structure.join(""),
    clean = visible.join("");
  const stack: number[] = [];
  for (let n = 0; n < skeleton.length; n++) {
    if (skeleton[n] === "(") stack.push(n);
    else if (skeleton[n] === ")") {
      if (stack.length) stack.pop();
      else
        issues.push({
          offset: n,
          message: "Closing parenthesis has no matching opening parenthesis",
        });
    }
  }
  for (const offset of stack)
    issues.push({
      offset,
      message: "Opening parenthesis has no matching closing parenthesis",
    });
  const statements: SqlRange[] = [];
  let start = 0;
  for (let n = 0; n <= skeleton.length; n++) {
    if (n < skeleton.length && skeleton[n] !== ";") continue;
    const segment = clean.slice(start, n);
    if (skeleton.slice(start, n).trim()) {
      const lead = segment.length - segment.trimStart().length,
        trail = segment.length - segment.trimEnd().length;
      statements.push({
        start: start + lead,
        end: n - trail,
        boundary: n,
        text: sql.slice(start + lead, n - trail),
      });
    }
    start = n + 1;
  }
  const compound =
    /\bDELIMITER\b|\bCREATE\b[^;]*\b(?:PROCEDURE|FUNCTION|TRIGGER|EVENT)\b|\bBEGIN\s+(?:NOT\s+)?ATOMIC\b/i.test(
      skeleton,
    );
  return {
    statements,
    issues,
    completionCode: completion.join(""),
    unsafe: executableComment
      ? "Executable MySQL comments require an explicit SQL selection or Run script."
      : compound
        ? "Routine/trigger scripts require an explicit SQL selection or Run script."
        : undefined,
  };
}
export function statementAt(analysis: SqlAnalysis, offset: number) {
  return (
    analysis.statements.find(
      (s) => offset >= s.start && offset <= s.boundary + 1,
    ) ??
    analysis.statements.filter((s) => s.end <= offset).at(-1) ??
    analysis.statements[0]
  );
}
export function currentSql(
  sql: string,
  driver: Driver,
  offset: number,
  selection?: string,
): { sql: string } | { error: string } {
  if (selection?.trim()) return { sql: selection };
  const analysis = analyseSql(sql, driver);
  if (analysis.unsafe) return { error: analysis.unsafe };
  if (analysis.issues.length)
    return {
      error: analysis.issues[0].message + ". Fix it or select SQL explicitly.",
    };
  const statement = statementAt(analysis, offset);
  return statement
    ? { sql: statement.text }
    : { error: "There is no statement at the cursor." };
}
const IDENT =
  '(?:"(?:[^"]|"")+"|`(?:[^`]|``)+`|\\[[^\\]]+\\]|[A-Za-z_][\\w$]*)';
const RESERVED = new Set(
  "WHERE SET ON JOIN LEFT RIGHT FULL INNER OUTER CROSS GROUP ORDER HAVING LIMIT OFFSET RETURNING UNION VALUES USING NATURAL FOR WITH AS".split(
    " ",
  ),
);
function identifier(text: string, driver: Driver) {
  if (text[0] === '"') return text.slice(1, -1).replaceAll('""', '"');
  if (text[0] === "`") return text.slice(1, -1).replaceAll("``", "`");
  if (text[0] === "[") return text.slice(1, -1);
  return driver === "postgres" ? text.toLowerCase() : text;
}
/** Only unambiguous metadata bindings are offered; CTE/subquery aliases aren't guessed. */
export function tableBindings(
  code: string,
  tables: TableInfo[],
  driver: Driver,
) {
  const bindings: { table: TableInfo; alias: string }[] = [];
  const ctes = [
    ...code.matchAll(
      new RegExp(
        `(?:\\bWITH(?:\\s+RECURSIVE)?|,)\\s*(${IDENT})(?:\\s*\\([^)]*\\))?\\s+AS\\s*\\(`,
        "gi",
      ),
    ),
  ].map((m) => identifier(m[1], driver));
  const regex = new RegExp(
    `\\b(?:FROM|JOIN|UPDATE|INTO)\\s+(${IDENT})(?:\\s*\\.\\s*(${IDENT}))?(?:\\s+(?:AS\\s+)?(${IDENT}))?`,
    "gi",
  );
  let match: RegExpExecArray | null;
  while ((match = regex.exec(code))) {
    const name = identifier(match[2] ?? match[1], driver),
      schema = match[2] ? identifier(match[1], driver) : undefined;
    const equal = (a: string, b: string) =>
      driver === "postgres" ? a === b : a.toLowerCase() === b.toLowerCase();
    if (!schema && ctes.includes(name)) continue;
    const matches = tables.filter(
      (t) => equal(t.name, name) && (!schema || equal(t.schema, schema)),
    );
    if (matches.length !== 1) continue;
    if (match[3] && RESERVED.has(match[3].toUpperCase()))
      regex.lastIndex = match.index! + match[0].lastIndexOf(match[3]);
    const candidate =
      match[3] && !RESERVED.has(match[3].toUpperCase())
        ? identifier(match[3], driver)
        : name;
    bindings.push({ table: matches[0], alias: candidate });
  }
  return bindings.filter(
    (binding) =>
      !bindings.some(
        (other) =>
          other.alias === binding.alias &&
          (other.table.name !== binding.table.name ||
            other.table.schema !== binding.table.schema),
      ),
  );
}
export function completionQualifier(prefix: string, driver: Driver) {
  const match = new RegExp(`(${IDENT})\\s*\\.\\s*[\\w$]*$`).exec(prefix);
  return match ? identifier(match[1], driver) : undefined;
}

/** Bind checked offsets to their exact SQL snapshot; never execute stale selections. */
export function checkedSql(
  sql: string,
  driver: Driver,
  source: string,
  indexes: number[],
): { sql: string } | { error: string } {
  if (source !== sql)
    return { error: "SQL changed. Select the queries again." };
  const analysis = analyseSql(sql, driver);
  if (analysis.unsafe || analysis.issues.length)
    return { error: analysis.unsafe ?? analysis.issues[0].message };
  if (
    !indexes.length ||
    indexes.some(
      (index) => !Number.isInteger(index) || !analysis.statements[index],
    )
  )
    return { error: "Select a query to run." };
  return {
    sql: [...new Set(indexes)]
      .sort((a, b) => a - b)
      .map((index) => analysis.statements[index].text)
      .join(";\n\n"),
  };
}
