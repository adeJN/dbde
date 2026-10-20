import type { Driver } from "../types";

export type SqlTokenKind =
  "keyword" | "type" | "string" | "identifier" | "number" | "comment" | "text";
export interface SqlToken {
  kind: SqlTokenKind;
  text: string;
}
const KEYWORDS = new Set(
  `ADD ALL ALTER ALWAYS AND AS ASC AUTO_INCREMENT AUTOINCREMENT BEGIN BY CASCADE CASE
  CHARACTER CHARSET CHECK COLLATE COMMENT CONSTRAINT CREATE CURRENT_DATE
  CURRENT_TIMESTAMP DEFAULT DEFERRABLE DELETE DESC DISTINCT DROP ELSE END ENGINE EXISTS
  FOREIGN FROM FULL GENERATED GROUP HAVING IDENTITY IF IN INDEX INITIALLY INNER INSERT
  INTO IS JOIN KEY LEFT LIKE LIMIT MATERIALIZED NO NOT NULL ON OR ORDER OUTER PRIMARY
  REFERENCES REPLACE RESTRICT RIGHT ROW_FORMAT SELECT SET STORED TABLE TEMPORARY THEN
  TRIGGER UNION UNIQUE UNSIGNED UPDATE USING VALUES VIEW VIRTUAL WHEN WHERE WITH
  WITHOUT ZEROFILL`.split(/\s+/),
);
const TYPES = new Set(
  `BIGINT BIGSERIAL BINARY BIT BLOB BOOL BOOLEAN BYTEA CHAR CHARACTER_VARYING DATE
  DATETIME DECIMAL DOUBLE ENUM FLOAT INET INT INTEGER INTERVAL JSON JSONB LONGBLOB
  LONGTEXT MEDIUMBLOB MEDIUMINT MEDIUMTEXT MONEY NUMERIC PRECISION REAL SERIAL SMALLINT
  SMALLSERIAL TEXT TIME TIMESTAMP TIMESTAMPTZ TINYBLOB TINYINT TINYTEXT UUID VARBINARY
  VARCHAR VARYING YEAR`.split(/\s+/),
);
// Comments, strings and quoted identifiers per dialect; then numbers and words.
const PATTERNS: Record<Driver, RegExp> = {
  mysql:
    /(--[^\n]*|#[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^'\\]|\\.|'')*'?)|(`(?:[^`]|``)*`?|"(?:[^"\\]|\\.|"")*"?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w$]*)/g,
  postgres:
    /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*'?|\$([A-Za-z_]\w*)?\$[\s\S]*?\$\3\$)|("(?:[^"]|"")*"?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w$]*)/g,
  sqlite:
    /(--[^\n]*|\/\*[\s\S]*?\*\/)|('(?:[^']|'')*'?)|("(?:[^"]|"")*"?|`(?:[^`]|``)*`?|\[[^\]]*\]?)|(\b\d+(?:\.\d+)?\b)|([A-Za-z_][\w$]*)/g,
};
/** Splits SQL into tokens for display; every input character appears in one token. */
export function highlightSql(sql: string, driver: Driver): SqlToken[] {
  const tokens: SqlToken[] = [];
  const pattern = new RegExp(PATTERNS[driver].source, "g");
  let last = 0;
  const push = (kind: SqlTokenKind, text: string) => {
    if (!text) return;
    const previous = tokens[tokens.length - 1];
    if (previous?.kind === kind && kind === "text") previous.text += text;
    else tokens.push({ kind, text });
  };
  for (const match of sql.matchAll(pattern)) {
    push("text", sql.slice(last, match.index));
    const [whole, comment, string] = match;
    // Group numbers shift by one for postgres because of the dollar-quote tag group.
    const offset = driver === "postgres" ? 1 : 0;
    const identifier = match[3 + offset];
    const number = match[4 + offset];
    const word = match[5 + offset];
    if (comment) push("comment", whole);
    else if (string) push("string", whole);
    else if (identifier) push("identifier", whole);
    else if (number) push("number", whole);
    else if (word) {
      const upper = word.toUpperCase();
      push(
        KEYWORDS.has(upper) ? "keyword" : TYPES.has(upper) ? "type" : "text",
        whole,
      );
    } else push("text", whole);
    last = match.index + whole.length;
  }
  push("text", sql.slice(last));
  return tokens;
}
