import { useEffect, useRef, useState } from "react";
import { Database, Loader2, X } from "lucide-react";
import * as api from "../lib/api";
import type { Session } from "../types";
export interface DatabaseRequest {
  session: Session;
  database: string;
  mode: "create" | "edit";
}
export default function DatabaseDialog({
  request: r,
  onClose,
  onSubmit,
}: {
  request: DatabaseRequest;
  onClose: () => void;
  onSubmit: (change: api.DatabaseChange) => Promise<void>;
}) {
  const [name, setName] = useState(r.mode === "create" ? "" : r.database);
  const [charset, setCharset] = useState(r.mode === "create" ? "utf8mb4" : "");
  const [collation, setCollation] = useState("");
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLElement>(null);
  const mysql = r.session.config.driver === "mysql";
  const renaming = r.mode === "edit" && name.trim() !== r.database;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current
      ?.querySelector<HTMLInputElement>("input:not([readonly])")
      ?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (!mysql || r.mode !== "edit") return;
    let active = true;
    setLoading(true);
    api
      .execute(
        r.session.id,
        "SELECT CONVERT(DEFAULT_CHARACTER_SET_NAME USING utf8mb4), CONVERT(DEFAULT_COLLATION_NAME USING utf8mb4) FROM information_schema.SCHEMATA WHERE SCHEMA_NAME = DATABASE()",
        r.database,
      )
      .then((result) => {
        if (active) {
          setCharset(String(result.rows[0]?.[0] ?? ""));
          setCollation(String(result.rows[0]?.[1] ?? ""));
        }
      })
      .catch((e) => active && setError(String(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [r, mysql]);
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <section
        ref={root}
        className="modal database-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="database-dialog-title"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) onClose();
          if (e.key === "Tab") {
            const nodes = root.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled)",
            );
            if (!nodes?.length) return;
            const first = nodes[0],
              last = nodes[nodes.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header>
          <div className="modal-icon">
            <Database size={23} />
          </div>
          <button
            className="icon-button"
            aria-label="Close database dialog"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <h2 id="database-dialog-title">
          {r.mode === "create" ? "New Database" : "Edit Database"}
        </h2>
        <p>
          {r.session.config.name} ·{" "}
          {r.session.config.driver === "postgres"
            ? "PostgreSQL"
            : "MySQL / MariaDB"}
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            if (busy || loading) return;
            setBusy(true);
            setError("");
            void onSubmit({
              name: name.trim(),
              charset: charset.trim(),
              collation: collation.trim(),
            })
              .then(onClose)
              .catch((e) => setError(String(e)))
              .finally(() => setBusy(false));
          }}
        >
          <label>
            Database name
            <input
              disabled={busy}
              autoComplete="off"
              required
              value={name}
              maxLength={mysql ? 64 : 63}
              onChange={(e) => setName(e.target.value)}
            />
          </label>
          {mysql && r.mode === "edit" && (
            <p className="table-tools-note">
              Changing the name moves InnoDB tables to a new database and
              removes the empty source. Views, triggers, routines, events and
              cross-database foreign keys require a separate migration. Stop
              other writers and back up your database first. Applications and
              grants using the old name must be updated separately. Database
              defaults are preserved when renaming.
            </p>
          )}
          {mysql && (
            <>
              <label>
                Character set
                <input
                  disabled={busy || loading || renaming}
                  value={charset}
                  placeholder="Server default"
                  pattern="[A-Za-z0-9_]*"
                  onChange={(e) => setCharset(e.target.value)}
                />
              </label>
              <label>
                Collation
                <input
                  disabled={busy || loading || renaming}
                  value={collation}
                  placeholder="Default for character set"
                  pattern="[A-Za-z0-9_]*"
                  onChange={(e) => setCollation(e.target.value)}
                />
              </label>
            </>
          )}
          <p className="table-tools-note">
            {mysql
              ? "Changing database defaults applies to new tables. Existing table columns keep their current character set and collation."
              : r.mode === "edit"
                ? "Renames this database. Its open tabs and connections are closed after checking unsaved changes. Other clients may block renaming."
                : "Creates a database using the server's default owner, encoding and locale."}
          </p>
          {loading && <p role="status">Loading database settings…</p>}
          {error && (
            <p className="error" role="alert">
              {error}
            </p>
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
            <button
              type="submit"
              className="button primary"
              disabled={busy || loading || !name.trim()}
            >
              {busy && <Loader2 size={15} className="spin" />}
              {busy
                ? "Saving…"
                : r.mode === "create"
                  ? "Create Database"
                  : name.trim() !== r.database
                    ? "Rename Database…"
                    : "Save Changes"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
