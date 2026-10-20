import { useEffect, useMemo, useRef, useState } from "react";
import { Copy, Download, FileCode2, SquarePen, X } from "lucide-react";
import type { Driver, TableInfo } from "../types";
import { highlightSql } from "../lib/sql-highlight";

/**
 * Read-only view of a table or view definition. Editing or running it is a deliberate
 * step ("Open in SQL Editor"), so looking at a definition never adds tabs or risks
 * running CREATE statements by accident.
 */
export default function DdlDialog({
  table,
  database,
  driver,
  ddl,
  kindLabel,
  note,
  onCopy,
  onOpenInEditor,
  onSave,
  onClose,
}: {
  table: TableInfo;
  database: string;
  driver: Driver;
  ddl: string;
  /** What the definition describes, e.g. "function"; defaults to table or view. */
  kindLabel?: string;
  /** Replaces the PostgreSQL table note; null shows no note. */
  note?: string | null;
  onCopy: (ddl: string) => Promise<void>;
  onOpenInEditor: (ddl: string) => void;
  onSave: (ddl: string) => Promise<string | null>;
  onClose: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>();
  const tokens = useMemo(() => highlightSql(ddl, driver), [ddl, driver]);
  const name = `${table.schema ? table.schema + "." : ""}${table.name}`;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLElement>("pre")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  async function run(action: () => Promise<string>) {
    try {
      setStatus({ text: await action() });
    } catch (cause) {
      setStatus({ text: String(cause), error: true });
    }
  }
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={root}
        className="modal ddl-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="ddl-title"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
          if (event.key === "Tab") {
            const nodes = root.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), [tabindex='0']",
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
            <FileCode2 size={20} />
          </div>
          <button
            className="icon-button"
            aria-label="Close DDL"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <h2 id="ddl-title">
          DDL · {name}
          <small>
            {database} ·{" "}
            {kindLabel ?? (table.kind === "view" ? "view" : "table")} ·
            read-only
          </small>
        </h2>
        {note && <p className="ddl-note object-note">{note}</p>}
        {note === undefined && driver === "postgres" && (
          <p className="ddl-note">
            Built from the PostgreSQL catalog: columns, constraints and indexes.
            Triggers, comments, grants and partitions are not included.
          </p>
        )}
        <pre
          className="ddl-code"
          tabIndex={0}
          aria-label={`Definition of ${name}`}
        >
          <code>
            {tokens.map((token, index) =>
              token.kind === "text" ? (
                token.text
              ) : (
                <span key={index} className={`sql-${token.kind}`}>
                  {token.text}
                </span>
              ),
            )}
          </code>
        </pre>
        {status && (
          <div
            className={`form-message ${status.error ? "error" : "success"}`}
            role={status.error ? "alert" : "status"}
          >
            {status.text}
          </div>
        )}
        <footer>
          <button
            className="button secondary"
            onClick={() =>
              void run(async () => {
                await onCopy(ddl);
                return "DDL copied.";
              })
            }
          >
            <Copy size={14} /> Copy
          </button>
          <button
            className="button secondary"
            onClick={() =>
              void run(async () => {
                const saved = await onSave(ddl);
                return saved ? `Saved to ${saved}` : "Save cancelled.";
              })
            }
          >
            <Download size={14} /> Save .sql
          </button>
          <button
            className="button primary"
            title="Open in a new SQL tab to edit or run it"
            onClick={() => onOpenInEditor(ddl)}
          >
            <SquarePen size={14} /> Open in SQL Editor
          </button>
        </footer>
      </section>
    </div>
  );
}
