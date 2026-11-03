import { useEffect, useRef, useState } from "react";
import { Copy, X, Loader2, ArrowUpRight } from "lucide-react";
import * as api from "../lib/api";
import { useProcessReports, processFailure } from "../lib/process-reports";
import { mappedRecords, readTable } from "../lib/table-tools";
import type { ColumnMapping, Session, TableInfo } from "../types";

export interface TableToolRequest {
  session: Session;
  database: string;
  table: TableInfo;
  mode: "copy" | "transfer";
  data: boolean;
}
export default function TableToolsDialog({
  request: r,
  sessions,
  onClose,
  onDone,
}: {
  request: TableToolRequest;
  sessions: Session[];
  onClose: () => void;
  onDone: (
    connectionId: string,
    database: string,
    message: string,
    target?: TableInfo,
  ) => void;
}) {
  const [connectionId, setConnectionId] = useState(r.session.id);
  const targetSession = sessions.find((s) => s.id === connectionId);
  const [database, setDatabase] = useState(r.database);
  const [schema, setSchema] = useState(r.table.schema);
  const [name, setName] = useState(`${r.table.name}_copy`);
  const [data, setData] = useState(r.data);
  const [tables, setTables] = useState<TableInfo[]>([]);
  const [targetIndex, setTargetIndex] = useState("");
  const [mapping, setMapping] = useState<ColumnMapping[]>([]);
  const [sourceColumns, setSourceColumns] = useState<string[]>([]);
  const [targetColumns, setTargetColumns] = useState<string[]>([]);
  const [busy, setBusy] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const root = useRef<HTMLElement>(null);
  const operationId = useRef<string>();
  const copy = r.mode === "copy";
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current
      ?.querySelector<HTMLInputElement | HTMLSelectElement>("input, select")
      ?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
      else
        Array.from(document.querySelectorAll<HTMLButtonElement>("button"))
          .find(
            (button) =>
              button.getAttribute("aria-label") ===
              `Actions for ${r.table.name}`,
          )
          ?.focus();
    };
  }, [r.table.name]);
  useEffect(() => {
    if (copy) return;
    let active = true;
    setLoading(true);
    setError("");
    setTargetIndex("");
    setTables([]);
    setMapping([]);
    Promise.all([
      api.schema(connectionId, database),
      api.exportColumns(r.session.id, r.database, r.table),
    ])
      .then(([tree, cols]) => {
        if (active) {
          setTables(tree.tables.filter((t) => t.kind === "table"));
          setSourceColumns(cols);
        }
      })
      .catch((e) => active && setError(String(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [connectionId, database, copy, r]);
  useEffect(() => {
    if (copy || !targetIndex) return;
    let active = true;
    setLoading(true);
    setMapping([]);
    setTargetColumns([]);
    api
      .exportColumns(connectionId, database, tables[Number(targetIndex) - 1])
      .then((cols) => {
        if (active) {
          setTargetColumns(cols);
          setMapping(
            cols
              .filter((c) => sourceColumns.includes(c))
              .map((c) => ({ source: c, target: c })),
          );
        }
      })
      .catch((e) => active && setError(String(e)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [targetIndex, tables, connectionId, database, copy, sourceColumns]);
  async function submit() {
    if (busy || loading) return;
    setBusy(true);
    setError("");
    const reports = useProcessReports.getState();
    const reportId = copy
      ? undefined
      : reports.start(
          "Transfer records",
          `${r.database} / ${r.table.name} → ${database}`,
        );

    try {
      if (copy) {
        operationId.current = crypto.randomUUID();
        await api.copyTable(
          r.session.id,
          r.database,
          r.table,
          { name: name.trim(), schema, kind: "table" },
          data,
          operationId.current,
        );
        onDone(
          r.session.id,
          schema && r.session.config.driver === "mysql" ? schema : r.database,
          `Created ${name.trim()}${data ? " with data" : " (structure only)"}.`,
          { name: name.trim(), schema, kind: "table" },
        );
      } else {
        const target = tables[Number(targetIndex) - 1];
        if (!target) throw new Error("Choose a target table.");
        if (
          connectionId === r.session.id &&
          database === r.database &&
          target.name === r.table.name &&
          target.schema === r.table.schema
        )
          throw new Error("Source and target must be different tables.");
        if (!mapping.length) throw new Error("Map at least one column.");
        let count: number;
        operationId.current = crypto.randomUUID();
        if (api.desktop)
          count = await api.transferRecords(
            r.session.id,
            r.database,
            r.table,
            connectionId,
            database,
            target,
            mapping,
            operationId.current,
          );
        else {
          const result = await readTable(
            r.session.id,
            r.database,
            r.table,
            r.session.config.driver,
            5000,
            (rows) => {
              if (reportId) reports.progress(reportId, "Reading records", rows);
            },
          );
          const changes = mappedRecords(result, mapping);
          count = changes.length
            ? await api.applyChanges(
                connectionId,
                { database, table: target, primary_keys: [] },
                changes,
              )
            : 0;
        }
        operationId.current = undefined;
        if (reportId)
          reports.finish(
            reportId,
            "success",
            `${count} records transferred to ${target.name}`,
          );
        onDone(
          connectionId,
          database,
          `Transferred ${count} records to ${target.name}.`,
          target,
        );
      }
    } catch (e) {
      if (reportId) reports.finish(reportId, "error", processFailure(e));
      operationId.current = undefined;
      setError(String(e));
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onClick={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <section
        ref={root}
        className="modal table-tools-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="table-tools-title"
        onKeyDown={(e) => {
          if (e.key === "Escape" && !busy) onClose();
          if (e.key === "Tab") {
            const nodes = root.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
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
            {copy ? <Copy size={23} /> : <ArrowUpRight size={23} />}
          </div>
          <button
            className="icon-button"
            aria-label="Close dialog"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <h2 id="table-tools-title">
          {copy ? "Copy table" : "Transfer records"}
        </h2>
        <p>
          Source: {r.database} · {r.table.name}
        </p>
        <fieldset disabled={busy} className="table-tools-fields">
          {copy ? (
            <>
              <label>
                New table name
                <input
                  value={name}
                  maxLength={128}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              {r.session.config.driver !== "sqlite" && (
                <label>
                  {r.session.config.driver === "mysql"
                    ? "Target database"
                    : "Target schema"}
                  <input
                    value={schema}
                    onChange={(e) => setSchema(e.target.value)}
                  />
                </label>
              )}
              <label className="save-option">
                <input
                  type="checkbox"
                  checked={data}
                  onChange={(e) => setData(e.target.checked)}
                />{" "}
                Include all records
              </label>
              <p className="table-tools-note">
                Creates a new table without overwriting existing tables. Columns
                and indexes are copied. Triggers, permissions and external
                relationships require separate review.
              </p>
            </>
          ) : (
            <>
              <label>
                Target connection
                <select
                  value={connectionId}
                  onChange={(e) => {
                    const s = sessions.find((s) => s.id === e.target.value)!;
                    setConnectionId(s.id);
                    setDatabase(s.databases?.[0] ?? s.config.database);
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
                Target database
                <select
                  value={database}
                  onChange={(e) => setDatabase(e.target.value)}
                >
                  {[...new Set([database, ...(targetSession?.databases ?? [])])]
                    .filter(Boolean)
                    .map((d) => (
                      <option key={d}>{d}</option>
                    ))}
                </select>
              </label>
              <label>
                Existing target table
                <select
                  value={targetIndex}
                  onChange={(e) => setTargetIndex(e.target.value)}
                >
                  <option value="">Choose a table…</option>
                  {tables.map((t, i) => (
                    <option key={`${t.schema}.${t.name}`} value={String(i + 1)}>
                      {t.schema ? `${t.schema}.` : ""}
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
              {!!targetColumns.length && (
                <div className="column-mapping">
                  <strong>Source → target column</strong>
                  {targetColumns.map((target) => (
                    <label key={target}>
                      <span>{target}</span>
                      <select
                        aria-label={`Source for ${target}`}
                        value={
                          mapping.find((m) => m.target === target)?.source ?? ""
                        }
                        onChange={(e) =>
                          setMapping((old) => [
                            ...old.filter((m) => m.target !== target),
                            ...(e.target.value
                              ? [{ source: e.target.value, target }]
                              : []),
                          ])
                        }
                      >
                        <option value="">Use default / omit</option>
                        {sourceColumns.map((c) => (
                          <option key={c}>{c}</option>
                        ))}
                      </select>
                    </label>
                  ))}
                </div>
              )}
              <p className="table-tools-note">
                Appends up to 5,000,000 on desktop (5,000 in browser) saved
                scalar records in one transaction. Existing rows stay. Duplicate
                keys or invalid values cancel the entire transfer. Omit
                auto-generated IDs to use target defaults. Pause other writes
                while transferring.
              </p>
            </>
          )}
        </fieldset>
        {loading && <p role="status">Loading columns…</p>}
        {error && (
          <p className="error" role="alert">
            {error}
          </p>
        )}
        <footer>
          <button
            className="button secondary"
            disabled={busy && !operationId.current}
            onClick={() =>
              busy && operationId.current
                ? void api
                    .cancelOperation(operationId.current)
                    .catch((e) => setError(String(e)))
                : onClose()
            }
          >
            {busy ? (copy ? "Cancel copy" : "Cancel transfer") : "Cancel"}
          </button>
          <button
            className="button primary"
            disabled={
              busy ||
              loading ||
              (copy ? !name.trim() : !targetIndex || !mapping.length)
            }
            onClick={() => void submit()}
          >
            {busy ? <Loader2 className="spin" size={16} /> : null}
            {busy ? "Working…" : copy ? "Create copy" : "Transfer records"}
          </button>
        </footer>
      </section>
    </div>
  );
}
