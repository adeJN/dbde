/**
 * Query history (Navicat's History Log): one entry per SQL run from the editor.
 * Entries are stored by the desktop backend (an append-only file shared by every
 * window) or, in the browser sandbox, in localStorage within a smaller budget.
 */
export type HistoryStatus = "success" | "error" | "cancelled";
export interface HistoryEntry {
  id: string;
  /** Epoch milliseconds when the statement started. */
  at: number;
  profile_id: string;
  connection_name: string;
  database: string;
  sql: string;
  /** True when `sql` was cut to MAX_HISTORY_SQL_BYTES. */
  truncated: boolean;
  duration_ms: number;
  status: HistoryStatus;
  /** Rows returned by a result set. */
  rows?: number;
  /** Rows changed by INSERT/UPDATE/DELETE. */
  affected?: number;
  /** Short error message (first line, capped). */
  error?: string;
}
export const MAX_HISTORY_SQL_BYTES = 64 * 1024;
export const MAX_HISTORY_ENTRIES = 2000;
/** Sandbox (localStorage) budget; the desktop file allows 8 MB. */
export const SANDBOX_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_ERROR_CHARS = 300;
export const HISTORY_ENABLED_KEY = "dbde.history-enabled";

/** Cuts text to at most `maxBytes` of UTF-8 without splitting a character. */
export function truncateUtf8(text: string, maxBytes: number) {
  const bytes = new TextEncoder().encode(text);
  if (bytes.length <= maxBytes) return { text, truncated: false };
  let end = maxBytes;
  // Continuation bytes look like 10xxxxxx; step back to a character boundary.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return {
    text: new TextDecoder().decode(bytes.subarray(0, end)),
    truncated: true,
  };
}

/** Masks passwords in CREATE/ALTER USER and SET PASSWORD so history never keeps them. */
export function redactSecrets(sql: string) {
  const literal = `('(?:[^'\\\\]|\\\\.|'')*'|"(?:[^"\\\\]|\\\\.)*")`;
  return (
    sql
      // PostgreSQL dollar-quoted credentials can span lines and contain quotes.
      .replace(
        /(\b(?:ENCRYPTED\s+|UNENCRYPTED\s+)?PASSWORD\s*(?:=\s*)?)(\$(?:[a-z_][a-z0-9_]*)?\$)[\s\S]*?\2/gi,
        "$1'***'",
      )
      .replace(
        /(\b(?:ENCRYPTED\s+|UNENCRYPTED\s+)?PASSWORD\s*(?:=\s*)?)E('(?:[^'\\]|\\.|'')*')/gi,
        "$1'***'",
      )
      .replace(
        new RegExp(
          `(\\bIDENTIFIED\\s+(?:WITH\\s+\\S+\\s+)?BY\\s+)${literal}`,
          "gi",
        ),
        "$1'***'",
      )
      .replace(
        new RegExp(
          `(\\b(?:ENCRYPTED\\s+|UNENCRYPTED\\s+)?PASSWORD\\s*(?:=\\s*)?(?:\\(\\s*)?)${literal}`,
          "gi",
        ),
        "$1'***'",
      )
  );
}

export function shortError(message: string) {
  const line = message.replace(/^Error:\s*/, "").trim();
  return line.length > MAX_ERROR_CHARS
    ? `${line.slice(0, MAX_ERROR_CHARS - 1)}…`
    : line;
}

/** Recognises server messages for a cancelled or timed-out statement. */
export function isCancelledError(message: string) {
  return /cancel(l)?ed|canceling statement|query execution was interrupted|timed out/i.test(
    message,
  );
}

export function historyEntry(input: {
  id?: string;
  at: number;
  profileId: string;
  connectionName: string;
  database?: string;
  sql: string;
  durationMs: number;
  result?: { rows: unknown[]; affected_rows: number; columns: string[] };
  error?: string;
  cancelled?: boolean;
}): HistoryEntry {
  const { text, truncated } = truncateUtf8(
    redactSecrets(input.sql),
    MAX_HISTORY_SQL_BYTES,
  );
  const entry: HistoryEntry = {
    id: input.id ?? crypto.randomUUID(),
    at: input.at,
    profile_id: input.profileId,
    connection_name: input.connectionName,
    database: input.database ?? "",
    sql: text,
    truncated,
    duration_ms: Math.max(0, Math.round(input.durationMs)),
    status:
      input.error === undefined
        ? "success"
        : input.cancelled || isCancelledError(input.error)
          ? "cancelled"
          : "error",
  };
  if (input.error !== undefined)
    entry.error = /\b(?:PASSWORD|IDENTIFIED)\b/i.test(input.sql)
      ? "Credential statement failed. Review details in the query tab."
      : shortError(input.error);
  else if (input.result) {
    if (input.result.columns.length) entry.rows = input.result.rows.length;
    else entry.affected = input.result.affected_rows;
  }
  return entry;
}

export function isHistoryEntry(value: unknown): value is HistoryEntry {
  const entry = value as HistoryEntry;
  return (
    !!entry &&
    typeof entry === "object" &&
    typeof entry.id === "string" &&
    typeof entry.at === "number" &&
    typeof entry.profile_id === "string" &&
    typeof entry.connection_name === "string" &&
    typeof entry.database === "string" &&
    typeof entry.sql === "string" &&
    typeof entry.duration_ms === "number" &&
    ["success", "error", "cancelled"].includes(entry.status)
  );
}
/** Keeps valid entries, oldest first, without duplicate ids. */
export function readHistory(list: unknown): HistoryEntry[] {
  if (!Array.isArray(list)) return [];
  const seen = new Set<string>();
  return list.filter((value): value is HistoryEntry => {
    if (!isHistoryEntry(value) || seen.has(value.id)) return false;
    seen.add(value.id);
    return true;
  });
}

/** Drops the oldest entries until both caps hold (entries are oldest first). */
export function capHistory(
  entries: HistoryEntry[],
  maxEntries = MAX_HISTORY_ENTRIES,
  maxBytes = SANDBOX_HISTORY_BYTES,
) {
  const kept: HistoryEntry[] = [];
  let size = 2;
  for (let index = entries.length - 1; index >= 0; index--) {
    const length = JSON.stringify(entries[index]).length + 1;
    if (kept.length >= maxEntries || size + length > maxBytes) break;
    size += length;
    kept.push(entries[index]);
  }
  return kept.reverse();
}

export function mergeHistory(entries: HistoryEntry[], entry: HistoryEntry) {
  if (entries.some((item) => item.id === entry.id)) return entries;
  return capHistory([...entries, entry], MAX_HISTORY_ENTRIES, Infinity);
}

export interface HistoryFilter {
  text?: string;
  profileId?: string;
  database?: string;
  status?: HistoryStatus | "";
}
/** Matching entries, newest first. Every word of `text` must appear. */
export function filterHistory(entries: HistoryEntry[], filter: HistoryFilter) {
  const words = (filter.text ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  return entries
    .filter(
      (entry) =>
        (!filter.profileId || entry.profile_id === filter.profileId) &&
        (!filter.database || entry.database === filter.database) &&
        (!filter.status || entry.status === filter.status) &&
        words.every((word) =>
          `${entry.sql}\n${entry.connection_name}\n${entry.database}\n${entry.error ?? ""}`
            .toLowerCase()
            .includes(word),
        ),
    )
    .sort((a, b) => b.at - a.at);
}

export function historySummary(entry: HistoryEntry) {
  if (entry.status === "cancelled") return "Cancelled";
  if (entry.status === "error") return entry.error || "Failed";
  if (entry.rows !== undefined)
    return `${entry.rows.toLocaleString()} row${entry.rows === 1 ? "" : "s"}`;
  if (entry.affected !== undefined)
    return `${entry.affected.toLocaleString()} affected`;
  return "Done";
}

export function formatDuration(ms: number) {
  if (ms < 1000) return `${ms} ms`;
  if (ms < 60_000) return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
  return `${Math.floor(ms / 60_000)} min ${Math.round((ms % 60_000) / 1000)} s`;
}

export function historyEnabled(storage: Pick<Storage, "getItem"> | undefined) {
  try {
    return storage?.getItem(HISTORY_ENABLED_KEY) !== "false";
  } catch {
    return true;
  }
}
