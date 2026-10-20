import { useEffect, useMemo, useRef, useState } from "react";
import {
  ClipboardCopy,
  CornerDownLeft,
  History,
  Search,
  SquarePlus,
  Trash2,
  X,
} from "lucide-react";
import {
  filterHistory,
  formatDuration,
  historySummary,
  type HistoryEntry,
  type HistoryStatus,
} from "../lib/query-history";

export const HISTORY_PAGE = 100;

/** Navicat-style history log of SQL run from the editor, newest first. */
export default function HistoryPanel({
  entries,
  enabled,
  canInsert,
  onToggleEnabled,
  onOpen,
  onInsert,
  onCopy,
  onDelete,
  onClear,
  onClose,
}: {
  entries: HistoryEntry[];
  enabled: boolean;
  /** Whether a SQL editor tab is active to insert into. */
  canInsert: boolean;
  onToggleEnabled: (enabled: boolean) => void;
  onOpen: (entry: HistoryEntry) => void;
  onInsert: (entry: HistoryEntry) => void;
  onCopy: (entry: HistoryEntry) => Promise<void>;
  onDelete: (entry: HistoryEntry) => void;
  onClear: () => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [connection, setConnection] = useState("");
  const [database, setDatabase] = useState("");
  const [status, setStatus] = useState<HistoryStatus | "">("");
  const [limit, setLimit] = useState(HISTORY_PAGE);
  const [message, setMessage] = useState("");
  const connections = useMemo(() => {
    const names = new Map<string, string>();
    for (const entry of entries)
      names.set(entry.profile_id, entry.connection_name);
    return [...names].sort((a, b) => a[1].localeCompare(b[1]));
  }, [entries]);
  const databases = useMemo(
    () =>
      [
        ...new Set(
          entries
            .filter((e) => !connection || e.profile_id === connection)
            .map((e) => e.database)
            .filter(Boolean),
        ),
      ].sort(),
    [entries, connection],
  );
  const matches = useMemo(
    () =>
      filterHistory(entries, {
        text,
        profileId: connection,
        database,
        status,
      }),
    [entries, text, connection, database, status],
  );
  useEffect(() => setLimit(HISTORY_PAGE), [text, connection, database, status]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    search.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const time = (at: number) => {
    const date = new Date(at);
    return date.toDateString() === new Date().toDateString()
      ? date.toLocaleTimeString()
      : date.toLocaleString();
  };
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={root}
        className="modal library-dialog history-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="history-title"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
          if (event.key === "Tab") {
            const nodes = root.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
            );
            if (!nodes?.length) return;
            const first = nodes[0];
            const last = nodes[nodes.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header>
          <div className="modal-icon">
            <History size={20} />
          </div>
          <div className="library-heading">
            <h2 id="history-title">Query history</h2>
            <small>
              {entries.length.toLocaleString()} statement
              {entries.length === 1 ? "" : "s"} run from the SQL editor
            </small>
          </div>
          <button
            className="icon-button"
            aria-label="Close history"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="library-toolbar">
          <label className="library-search">
            <Search size={14} />
            <input
              ref={search}
              value={text}
              placeholder="Search SQL, connection or error…"
              aria-label="Search history"
              onChange={(event) => setText(event.target.value)}
            />
          </label>
          <select
            aria-label="Filter by connection"
            value={connection}
            onChange={(event) => {
              setConnection(event.target.value);
              setDatabase("");
            }}
          >
            <option value="">All connections</option>
            {connections.map(([id, name]) => (
              <option key={id} value={id}>
                {name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by database"
            value={database}
            onChange={(event) => setDatabase(event.target.value)}
          >
            <option value="">All databases</option>
            {databases.map((name) => (
              <option key={name} value={name}>
                {name}
              </option>
            ))}
          </select>
          <select
            aria-label="Filter by status"
            value={status}
            onChange={(event) =>
              setStatus(event.target.value as HistoryStatus | "")
            }
          >
            <option value="">Any status</option>
            <option value="success">Succeeded</option>
            <option value="error">Failed</option>
            <option value="cancelled">Cancelled</option>
          </select>
        </div>
        <div className="library-settings">
          <label>
            <input
              type="checkbox"
              checked={enabled}
              onChange={(event) => onToggleEnabled(event.target.checked)}
            />
            Record query history
          </label>
          <span className="spacer" />
          <button
            className="button subtle"
            disabled={!entries.length}
            onClick={onClear}
          >
            <Trash2 size={13} /> Clear history…
          </button>
        </div>
        {!enabled && (
          <p className="library-note" role="note">
            History is off. New statements are not recorded in any window.
          </p>
        )}
        <span className="visually-hidden" role="status">
          {message}
        </span>
        <ol className="library-list" aria-label="History entries">
          {matches.slice(0, limit).map((entry) => (
            <li key={entry.id} className={`history-entry ${entry.status}`}>
              <div className="history-meta">
                <span className={`history-status ${entry.status}`}>
                  {entry.status === "success"
                    ? "OK"
                    : entry.status === "error"
                      ? "Error"
                      : "Cancelled"}
                </span>
                <time dateTime={new Date(entry.at).toISOString()}>
                  {time(entry.at)}
                </time>
                <span>{formatDuration(entry.duration_ms)}</span>
                <span className="history-target">
                  {entry.connection_name}
                  {entry.database ? ` / ${entry.database}` : ""}
                </span>
                <span className="history-summary" title={historySummary(entry)}>
                  {historySummary(entry)}
                </span>
              </div>
              <pre className="history-sql" title={entry.sql}>
                {entry.sql}
                {entry.truncated ? "\n… (truncated)" : ""}
              </pre>
              <div className="library-actions">
                <button
                  className="button subtle"
                  aria-label={`Open in new query tab: ${entry.sql.slice(0, 60)}`}
                  onClick={() => onOpen(entry)}
                >
                  <SquarePlus size={13} /> Open in new tab
                </button>
                <button
                  className="button subtle"
                  disabled={!canInsert}
                  title={
                    canInsert
                      ? "Insert at the cursor of the current SQL editor"
                      : "Open a query tab first"
                  }
                  onClick={() => onInsert(entry)}
                >
                  <CornerDownLeft size={13} /> Insert
                </button>
                <button
                  className="button subtle"
                  onClick={() =>
                    void onCopy(entry).then(
                      () => setMessage("SQL copied."),
                      (cause) => setMessage(String(cause)),
                    )
                  }
                >
                  <ClipboardCopy size={13} /> Copy
                </button>
                <button
                  className="icon-button"
                  aria-label="Delete history entry"
                  title="Delete entry"
                  onClick={() => onDelete(entry)}
                >
                  <Trash2 size={13} />
                </button>
              </div>
            </li>
          ))}
        </ol>
        {!matches.length && (
          <p className="empty-inline" role="status">
            {entries.length
              ? "No history matches these filters."
              : "No queries yet. Statements you run from the SQL editor appear here."}
          </p>
        )}
        {matches.length > limit && (
          <button
            className="button secondary library-more"
            onClick={() => setLimit((value) => value + HISTORY_PAGE)}
          >
            Show more ({(matches.length - limit).toLocaleString()} older)
          </button>
        )}
      </section>
    </div>
  );
}
