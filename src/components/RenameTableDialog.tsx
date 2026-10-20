import { useEffect, useRef, useState } from "react";
import { Loader2, PencilLine, X } from "lucide-react";
import type { Driver, TableInfo } from "../types";
import { renameTableSql, tableNameError } from "../lib/sql";

/** What a rename can break, per database (shown before renaming). */
function impact(driver: Driver, kind: string) {
  if (driver === "postgres")
    return "Views, foreign keys and indexes follow the rename automatically. SQL saved elsewhere (functions, application code) that uses the old name must be updated.";
  if (driver === "mysql")
    return `Foreign keys, indexes and triggers move with the ${kind}. Views, stored routines and application code that use the old name stop working until they are updated.`;
  return "Indexes, triggers and views that use this table are updated automatically. Application code that uses the old name must be updated.";
}

export default function RenameTableDialog({
  table,
  database,
  driver,
  existing,
  onRename,
  onClose,
}: {
  table: TableInfo;
  database: string;
  driver: Driver;
  /** Tables and views already in the database, to catch name clashes early. */
  existing: TableInfo[];
  /** Resolves when renamed; rejects with the reason shown in the dialog. */
  onRename: (name: string) => Promise<void>;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(table.name);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const kind = table.kind === "view" ? "view" : "table";
  const problem = tableNameError(table, name, driver, existing);
  const untouched = name === table.name;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    input.current?.select();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  async function submit() {
    if (problem || busy) return;
    setBusy(true);
    setFailure("");
    try {
      await onRename(name);
    } catch (cause) {
      setFailure(String(cause));
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="modal rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="rename-title"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header>
          <div className="modal-icon">
            <PencilLine size={20} />
          </div>
          <button
            className="icon-button"
            aria-label="Close rename"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <h2 id="rename-title">
          Rename {kind} {table.name}
        </h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label>
            New name
            <input
              ref={input}
              value={name}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!!problem && !untouched}
              aria-describedby="rename-problem"
              onChange={(event) => {
                setName(event.target.value);
                setFailure("");
              }}
            />
          </label>
          <small id="rename-problem" className="rename-problem" role="status">
            {untouched ? "" : problem}
          </small>
          <p className="rename-impact">
            {database}
            {table.schema && table.schema !== database
              ? ` · ${table.schema}`
              : ""}{" "}
            · {impact(driver, kind)}
          </p>
          {!problem && (
            <pre className="rename-sql" aria-label="SQL to run">
              {renameTableSql(table, name, driver)}
            </pre>
          )}
          {failure && (
            <div className="form-message error" role="alert">
              {failure}
            </div>
          )}
          <footer>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </button>
            <button className="button primary" disabled={!!problem || busy}>
              {busy && <Loader2 size={14} className="spin" />} Rename
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
