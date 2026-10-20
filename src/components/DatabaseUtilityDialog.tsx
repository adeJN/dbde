import { useAutoDismiss } from "../hooks/useAutoDismiss";
import { useEffect, useMemo, useRef, useState } from "react";
import { Search, X, Copy, Download } from "lucide-react";
import * as api from "../lib/api";
import { writeClipboard } from "../lib/clipboard";
import { databaseFileName, sharedDatabaseProfile } from "../lib/database-tools";
import type { Session, TableInfo } from "../types";
export interface DatabaseUtilityRequest {
  session: Session;
  database: string;
  mode: "find" | "share";
  connection?: boolean;
}
export default function DatabaseUtilityDialog({
  request: r,
  onClose,
  onOpen,
}: {
  request: DatabaseUtilityRequest;
  onClose: () => void;
  onOpen: (table: TableInfo) => void;
}) {
  const [search, setSearch] = useState("");
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [columns, setColumns] = useState<Record<string, string[]>>({});
  const [searchColumns, setSearchColumns] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [message, setMessage] = useState("");
  const messageDismiss = useAutoDismiss(message, () => setMessage(""), !error);
  const root = useRef<HTMLElement>(null);
  const find = r.mode === "find";
  const profile = sharedDatabaseProfile(r.session.config, r.database);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current
      ?.querySelector<HTMLElement>(find ? "input" : "button")
      ?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, [find]);
  useEffect(() => {
    if (!find) return;
    let active = true;
    setLoading(true);
    api
      .schema(r.session.id, r.database)
      .then((tree) => active && setTables(tree.tables))
      .catch((e) => active && setError(String(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [find, r]);
  useEffect(() => {
    if (!searchColumns || !tables.length) return;
    let active = true;
    if (tables.length > 200) {
      setError(
        "Column search supports up to 200 tables. Search table names for larger databases.",
      );
      return;
    }
    setLoading(true);
    setError("");
    let next = 0;
    const found: Record<string, string[]> = {};
    const worker = async () => {
      while (active && next < tables.length) {
        const table = tables[next++];
        const cols = await api.columns(r.session.id, table, r.database);
        found[JSON.stringify([table.schema, table.name])] = cols.map(
          (c) => c.name,
        );
      }
    };
    void Promise.all(Array.from({ length: Math.min(4, tables.length) }, worker))
      .then(() => active && setColumns(found))
      .catch((e) => active && setError(String(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [searchColumns, tables, r]);
  const results = useMemo(
    () =>
      tables.filter(
        (t) =>
          `${t.schema}.${t.name}`
            .toLowerCase()
            .includes(search.toLowerCase()) ||
          (searchColumns &&
            (columns[JSON.stringify([t.schema, t.name])] ?? []).some((c) =>
              c.toLowerCase().includes(search.toLowerCase()),
            )),
      ),
    [tables, columns, search, searchColumns],
  );
  const run = (action: () => Promise<unknown>, success: string) => {
    setError("");
    void action()
      .then(() => {
        if (success) setMessage(success);
      })
      .catch((e) => setError(String(e)));
  };
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && onClose()}
    >
      <section
        ref={root}
        className="modal database-utility-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="database-utility-title"
        onKeyDown={(e) => {
          if (e.key === "Escape") onClose();
          if (e.key === "Tab") {
            const nodes = root.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), textarea",
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
            <Search size={23} />
          </div>
          <button
            className="icon-button"
            aria-label="Close database utility"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <h2 id="database-utility-title">
          {find
            ? "Find in Database"
            : r.connection
              ? "Share Connection"
              : "Share Database Connection"}
        </h2>
        <p>{r.connection ? r.session.config.name : r.database}</p>
        {find ? (
          <>
            <label className="database-search-label">
              Find tables, views or columns
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Search this database…"
              />
            </label>
            <label className="database-column-search">
              <input
                type="checkbox"
                checked={searchColumns}
                onChange={(e) => setSearchColumns(e.target.checked)}
              />{" "}
              Include column names
            </label>
            {loading && <p role="status">Searching database metadata…</p>}
            <div className="database-search-results">
              {results.slice(0, 200).map((t) => (
                <button
                  key={JSON.stringify([t.schema, t.name])}
                  onClick={() => {
                    onOpen(t);
                    onClose();
                  }}
                >
                  <strong>
                    {t.schema ? t.schema + "." : ""}
                    {t.name}
                  </strong>
                  <small>
                    {t.kind}
                    {searchColumns && search
                      ? " · " +
                        (columns[JSON.stringify([t.schema, t.name])] ?? [])
                          .filter((c) =>
                            c.toLowerCase().includes(search.toLowerCase()),
                          )
                          .join(", ")
                      : ""}
                  </small>
                </button>
              ))}
              {!loading && !results.length && (
                <p>No matching tables or views.</p>
              )}
              {results.length > 200 && (
                <p>Showing the first 200 results. Refine your search.</p>
              )}
            </div>
          </>
        ) : (
          <>
            <p className="table-tools-note">
              Contains connection details only. Passwords, credentials and table
              data are excluded.
            </p>
            <textarea
              className="database-share-preview"
              aria-label="Connection profile without password"
              readOnly
              value={profile}
            />
            <footer>
              <button
                className="button secondary"
                onClick={() =>
                  run(
                    () => writeClipboard(profile),
                    "Connection profile copied.",
                  )
                }
              >
                <Copy size={14} /> Copy
              </button>
              <button
                className="button primary"
                onClick={() =>
                  run(async () => {
                    const saved = await api.saveFile(
                      databaseFileName(
                        r.connection ? r.session.config.name : r.database,
                        "json",
                      ),
                      "json",
                      profile,
                    );
                    if (!saved) return;
                    setMessage(`Saved to ${saved}`);
                  }, "")
                }
              >
                <Download size={14} /> Save JSON
              </button>
            </footer>
          </>
        )}
        {error && (
          <p role="alert" className="error">
            {error}
          </p>
        )}
        {message && (
          <p {...messageDismiss} role="status" className="form-message success">
            {message}
          </p>
        )}
      </section>
    </div>
  );
}
