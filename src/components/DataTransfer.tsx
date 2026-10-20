import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import { mappedRecords, readTable } from "../lib/table-tools";
import { modelTableKey } from "../lib/database-model";
import type { Session, TableInfo } from "../types";
export default function DataTransfer({
  session,
  database,
  tables,
  sessions,
  onChanged,
  onBusy,
}: {
  session: Session;
  database: string;
  tables: TableInfo[];
  sessions: Session[];
  onChanged: () => void;
  onBusy: (busy: boolean) => void;
}) {
  const [targetId, setTargetId] = useState(
      sessions.find((s) => s.id !== session.id)?.id ?? session.id,
    ),
    [targetDb, setTargetDb] = useState(""),
    [targetTables, setTargetTables] = useState<TableInfo[]>([]),
    [chosen, setChosen] = useState<string[]>([]),
    [mapping, setMapping] = useState<Record<string, string>>({}),
    [busy, setBusy] = useState(false),
    [loading, setLoading] = useState(false),
    [error, setError] = useState(""),
    [log, setLog] = useState<string[]>([]),
    [confirmed, setConfirmed] = useState(false);
  const stop = useRef(false),
    lock = useRef(false),
    completed = useRef(new Set<string>());
  const target = sessions.find((s) => s.id === targetId);
  useEffect(() => {
    setTargetDb(target?.databases?.[0] ?? target?.config.database ?? "");
  }, [targetId]);
  useEffect(() => {
    let active = true;
    setTargetTables([]);
    setMapping({});
    setConfirmed(false);
    completed.current.clear();
    setLog([]);
    if (!targetDb || !target) return;
    setLoading(true);
    void api
      .schema(targetId, targetDb)
      .then((tree) => {
        if (!active) return;
        const list = tree.tables.filter((t) => t.kind === "table");
        setTargetTables(list);
        setMapping(
          Object.fromEntries(
            tables.map((t) => [
              modelTableKey(t),
              list.find((x) => x.name === t.name)
                ? modelTableKey(list.find((x) => x.name === t.name)!)
                : "",
            ]),
          ),
        );
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
  }, [targetId, targetDb, tables]);
  async function transfer() {
    if (lock.current || !target || !confirmed) return;
    lock.current = true;
    stop.current = false;
    setBusy(true);
    onBusy(true);
    setError("");
    try {
      const tasks = [];
      for (const table of tables.filter(
        (t) =>
          chosen.includes(modelTableKey(t)) &&
          !completed.current.has(modelTableKey(t)),
      )) {
        const destination = targetTables.find(
          (t) => modelTableKey(t) === mapping[modelTableKey(table)],
        );
        if (!destination)
          throw new Error(
            `Choose an existing destination table for ${table.name}.`,
          );
        const sameEndpoint =
          session.config.driver === target.config.driver &&
          session.config.host === target.config.host &&
          session.config.port === target.config.port &&
          session.config.file_path === target.config.file_path;
        if (
          (session.id === targetId || sameEndpoint) &&
          database === targetDb &&
          modelTableKey(table) === modelTableKey(destination)
        )
          throw new Error("Source and destination must be different tables.");
        const sourceColumns = await api.exportColumns(
            session.id,
            database,
            table,
          ),
          destColumns = await api.exportColumns(
            targetId,
            targetDb,
            destination,
          );
        const names = sourceColumns.filter((c) => destColumns.includes(c));
        if (!names.length)
          throw new Error(
            `No matching writable field names for ${table.name}. Use single-table Transfer Records for custom field mappings.`,
          );
        tasks.push({
          table,
          destination,
          mapping: names.map((name) => ({ source: name, target: name })),
        });
      }
      for (const task of tasks) {
        if (stop.current) break;
        const result = await readTable(
          session.id,
          database,
          task.table,
          session.config.driver,
          5000,
        );
        const changes = mappedRecords(result, task.mapping);
        const count = changes.length
          ? await api.applyChanges(
              targetId,
              { database: targetDb, table: task.destination, primary_keys: [] },
              changes,
            )
          : 0;
        completed.current.add(modelTableKey(task.table));
        setLog((old) => [
          ...old,
          `${task.table.name} → ${task.destination.name}: ${count} records transferred.`,
        ]);
      }
      setLog((old) => [
        ...old,
        stop.current
          ? "Stopped between tables. Completed tables are retained."
          : "Transfer complete.",
      ]);
    } catch (e) {
      setError(
        `${String(e)} Completed tables are retained and skipped on retry.`,
      );
    } finally {
      if (completed.current.size) onChanged();
      lock.current = false;
      setBusy(false);
      onBusy(false);
    }
  }
  return (
    <>
      <p className="admin-muted">
        Append records from several tables to existing tables on another
        connection or server, including different engines. Fields match by name.
        Each table is atomic, with a limit of 5,000 scalar records; use
        export/import for larger or binary transfers. Existing destination
        records are retained.
      </p>
      <div className="admin-row">
        <label>
          Destination connection{" "}
          <select
            disabled={busy}
            value={targetId}
            onChange={(e) => setTargetId(e.target.value)}
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.config.name} · {s.config.driver}
              </option>
            ))}
          </select>
        </label>
        <label>
          Database{" "}
          <select
            disabled={busy}
            value={targetDb}
            onChange={(e) => setTargetDb(e.target.value)}
          >
            {(target?.databases?.length
              ? target.databases
              : [target?.config.database ?? ""]
            ).map((db) => (
              <option key={db}>{db}</option>
            ))}
          </select>
        </label>
        <button
          className="button subtle"
          disabled={busy}
          onClick={() => setChosen(tables.map(modelTableKey))}
        >
          Select all
        </button>
        <button
          className="button subtle"
          disabled={busy}
          onClick={() => setChosen([])}
        >
          Clear selection
        </button>
      </div>
      {loading && <p role="status">Loading destination tables…</p>}
      <table className="admin-data">
        <thead>
          <tr>
            <th>Select</th>
            <th>Source table</th>
            <th>Destination table</th>
          </tr>
        </thead>
        <tbody>
          {tables
            .filter((t) => t.kind === "table")
            .map((t) => {
              const key = modelTableKey(t);
              return (
                <tr key={key}>
                  <td>
                    <input
                      aria-label={`Transfer ${t.name}`}
                      type="checkbox"
                      disabled={busy || completed.current.has(key)}
                      checked={chosen.includes(key)}
                      onChange={(e) => {
                        setConfirmed(false);
                        setChosen((old) =>
                          e.target.checked
                            ? [...old, key]
                            : old.filter((x) => x !== key),
                        );
                      }}
                    />
                  </td>
                  <td>
                    {t.schema}.{t.name}
                    {completed.current.has(key) ? " · completed" : ""}
                  </td>
                  <td>
                    <select
                      aria-label={`Destination for ${t.name}`}
                      disabled={busy || completed.current.has(key)}
                      value={mapping[key] ?? ""}
                      onChange={(e) => {
                        setConfirmed(false);
                        setMapping((old) => ({
                          ...old,
                          [key]: e.target.value,
                        }));
                      }}
                    >
                      <option value="">Choose existing table…</option>
                      {targetTables.map((t) => (
                        <option key={modelTableKey(t)} value={modelTableKey(t)}>
                          {t.schema}.{t.name}
                        </option>
                      ))}
                    </select>
                  </td>
                </tr>
              );
            })}
        </tbody>
      </table>
      <div className="admin-row">
        <label>
          <input
            type="checkbox"
            disabled={busy}
            checked={confirmed}
            onChange={(e) => setConfirmed(e.target.checked)}
          />{" "}
          Append records to the selected destination tables
        </label>
        <button
          className="button primary"
          disabled={busy || loading || !chosen.length || !confirmed}
          onClick={() => void transfer()}
        >
          Transfer {chosen.length} tables
        </button>
        {busy && (
          <button
            className="button"
            onClick={() => {
              stop.current = true;
            }}
          >
            Stop after current table
          </button>
        )}
      </div>
      {busy && <p role="status">Transferring… Keep this window open.</p>}
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      <pre className="admin-sql" role="status">
        {log.join("\n")}
      </pre>
    </>
  );
}
