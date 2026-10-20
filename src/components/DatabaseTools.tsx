import { useEffect, useMemo, useRef, useState } from "react";
import { Database, X } from "lucide-react";
import {
  TOOL_GROUPS,
  TOOL_ICONS,
  type DatabaseToolPane,
} from "./databaseToolItems";
import type { Session, TableInfo } from "../types";
import * as api from "../lib/api";
import DataTransfer from "./DataTransfer";
import ServerMonitor from "./ServerMonitor";
import VisualQueryBuilder from "./VisualQueryBuilder";
import DatabaseModel from "./DatabaseModel";
import ObjectInformationPane from "./ObjectInformationPane";
export default function DatabaseTools({
  sessions,
  initialSessionId,
  initialDatabase,
  initialPane = "Data Transfer",
  onClose,
  onSQL,
  onChanged,
}: {
  sessions: Session[];
  initialSessionId: string;
  initialDatabase?: string;
  initialPane?: DatabaseToolPane;
  onClose: () => void;
  onSQL: (
    sessionId: string,
    database: string,
    sql: string,
    name: string,
  ) => void;
  onChanged: () => void;
}) {
  const [connectionId, setConnectionId] = useState(initialSessionId),
    [database, setDatabase] = useState(initialDatabase ?? ""),
    [pane, setPane] = useState<DatabaseToolPane>(initialPane),
    [tables, setTables] = useState<TableInfo[]>([]),
    [selected, setSelected] = useState("0"),
    [error, setError] = useState(""),
    [loading, setLoading] = useState(false),
    [busy, setBusy] = useState(false);
  const root = useRef<HTMLElement>(null),
    session = sessions.find((s) => s.id === connectionId) ?? sessions[0];
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLButtonElement>("button")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  useEffect(() => {
    if (!session) return;
    const dbs = session.databases?.length
      ? session.databases
      : [session.config.database];
    if (!dbs.includes(database)) setDatabase(dbs[0] ?? "");
  }, [session.id, database]);
  useEffect(() => {
    let active = true;
    setTables([]);
    setSelected("0");
    setError("");
    if (!database) return;
    setLoading(true);
    void api
      .schema(session.id, database)
      .then((tree) => {
        if (active) setTables(tree.tables);
      })
      .catch((e) => {
        if (active) setError(String(e));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [session.id, database]);
  const sourceTables = useMemo(
    () => tables.filter((t) => t.kind === "table"),
    [tables],
  );
  const toSQL = (sql: string) => onSQL(session.id, database, sql, pane);
  const key = JSON.stringify([session.id, database]);
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
    >
      <section
        ref={root}
        className={`modal database-tools-dialog${pane === "ER Model" ? " erd-tools-dialog" : ""}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby="database-tools-title"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) {
            e.stopPropagation();
            onClose();
          }
          if (e.key === "Tab") {
            const nodes = Array.from(
              root.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled),input:not(:disabled):not([hidden]),select:not(:disabled),textarea:not(:disabled),[tabindex="0"]',
              ) ?? [],
            ).filter((n) => n.getClientRects().length);
            if (!nodes.length) return;
            if (e.shiftKey && document.activeElement === nodes[0]) {
              e.preventDefault();
              nodes.at(-1)!.focus();
            } else if (!e.shiftKey && document.activeElement === nodes.at(-1)) {
              e.preventDefault();
              nodes[0].focus();
            }
          }
        }}
      >
        <header>
          <h2 id="database-tools-title">
            <Database size={19} /> Database Tools
          </h2>
          <button
            className="icon-button"
            aria-label="Close database tools"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="admin-context">
          <label>
            Connection{" "}
            <select
              value={session.id}
              disabled={busy}
              onChange={(e) => {
                setConnectionId(e.target.value);
                setDatabase("");
              }}
            >
              {sessions.map((s) => (
                <option key={s.id} value={s.id}>
                  {s.config.name}
                </option>
              ))}
            </select>
          </label>
          <label>
            Database{" "}
            <select
              value={database}
              disabled={busy}
              onChange={(e) => setDatabase(e.target.value)}
            >
              {(session.databases?.length
                ? session.databases
                : [session.config.database]
              ).map((db) => (
                <option key={db}>{db}</option>
              ))}
            </select>
          </label>
        </div>
        <div className="database-tools-body">
          <nav className="database-tools-toolbar" aria-label="Database tools">
            {TOOL_GROUPS.map((group) => (
              <section
                className="database-tool-section"
                role="group"
                aria-label={group.label}
                key={group.label}
              >
                {group.panes.map((p) => {
                  const Icon = TOOL_ICONS[p];
                  return (
                    <button
                      className={p === pane ? "active" : ""}
                      disabled={busy}
                      key={p}
                      aria-current={p === pane ? "page" : undefined}
                      onClick={() => setPane(p)}
                    >
                      <Icon size={15} aria-hidden="true" />
                      <span>{p}</span>
                    </button>
                  );
                })}
              </section>
            ))}
          </nav>
          <div
            className={`database-tools-content${pane === "ER Model" ? " erd-tools-content" : ""}`}
            key={`${key}:${pane}`}
          >
            {error && (
              <p role="alert" className="error-banner">
                {error}
              </p>
            )}
            {loading && <p role="status">Loading database objects…</p>}
            {!loading && !error && database && (
              <>
                {pane === "Data Transfer" && (
                  <DataTransfer
                    session={session}
                    database={database}
                    tables={sourceTables}
                    sessions={sessions}
                    onChanged={onChanged}
                    onBusy={setBusy}
                  />
                )}
                {pane === "Server Monitor" && (
                  <ServerMonitor session={session} database={database} />
                )}
                {pane === "Object Information" && (
                  <>
                    <label>
                      Object{" "}
                      <select
                        value={selected}
                        onChange={(e) => setSelected(e.target.value)}
                      >
                        {tables.map((t, i) => (
                          <option key={i} value={i}>
                            {t.schema}.{t.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    {tables[Number(selected)] && (
                      <ObjectInformationPane
                        session={session}
                        database={database}
                        table={tables[Number(selected)]}
                      />
                    )}
                  </>
                )}
                {pane === "Query Builder" && (
                  <VisualQueryBuilder
                    session={session}
                    database={database}
                    tables={tables}
                    onSQL={toSQL}
                  />
                )}
                {pane === "ER Model" && (
                  <DatabaseModel
                    session={session}
                    database={database}
                    onSQL={toSQL}
                  />
                )}
              </>
            )}
          </div>
        </div>
      </section>
    </div>
  );
}
