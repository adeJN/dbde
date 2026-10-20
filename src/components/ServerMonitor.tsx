import { useEffect, useRef, useState } from "react";
import * as api from "../lib/api";
import {
  killQuerySql,
  monitorSql,
  type MonitorSection,
} from "../lib/admin-tools";
import type { QueryResult, Session } from "../types";
export function AdminResult({
  result,
  onRow,
}: {
  result?: QueryResult;
  onRow?: (row: unknown[]) => void;
}) {
  return result ? (
    <div className="admin-result">
      <table className="admin-data">
        <thead>
          <tr>
            {result.columns.map((c) => (
              <th key={c}>{c}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {result.rows.map((row, i) => (
            <tr
              key={i}
              onClick={() => onRow?.(row)}
              tabIndex={onRow ? 0 : undefined}
              onKeyDown={(e) => {
                if (onRow && (e.key === "Enter" || e.key === " ")) {
                  e.preventDefault();
                  onRow(row);
                }
              }}
            >
              {row.map((value, n) => (
                <td key={n} title={value == null ? "NULL" : String(value)}>
                  {value == null ? "NULL" : String(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {result.truncated && (
        <p role="status">Result limit reached; the list is incomplete.</p>
      )}
    </div>
  ) : null;
}
export default function ServerMonitor({
  session,
  database,
}: {
  session: Session;
  database: string;
}) {
  const [section, setSection] = useState<MonitorSection>("Processes"),
    [result, setResult] = useState<QueryResult>(),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [auto, setAuto] = useState(false),
    [pid, setPid] = useState(""),
    [confirm, setConfirm] = useState(false),
    [version, setVersion] = useState(0);
  const inflight = useRef(false);
  useEffect(() => {
    let active = true;
    let reading = false;
    async function load() {
      if (reading || inflight.current) return;
      reading = true;
      if (active) setBusy(true);
      try {
        const next = await api.execute(
          session.id,
          monitorSql(session.config.driver, section),
          database,
        );
        if (active) {
          setResult(next);
          setError("");
        }
      } catch (e) {
        if (active) setError(String(e));
      } finally {
        reading = false;
        if (active) setBusy(false);
      }
    }
    void load();
    const timer = auto ? setInterval(() => void load(), 5000) : undefined;
    return () => {
      active = false;
      if (timer) clearInterval(timer);
    };
  }, [session.id, database, section, auto, version]);
  async function kill() {
    if (!confirm || inflight.current) return;
    inflight.current = true;
    setBusy(true);
    try {
      await api.execute(
        session.id,
        killQuerySql(session.config.driver, pid),
        database,
      );
      setConfirm(false);
      setPid("");
      setVersion((v) => v + 1);
    } catch (e) {
      setError(String(e));
    } finally {
      inflight.current = false;
      setBusy(false);
    }
  }
  return (
    <>
      <div className="admin-row">
        {(["Processes", "Variables", "Status"] as const).map((s) => (
          <button
            className={`button${section === s ? " active" : ""}`}
            key={s}
            disabled={busy}
            onClick={() => {
              setSection(s);
              setResult(undefined);
              setPid("");
            }}
          >
            {s}
          </button>
        ))}
        <button
          className="button"
          disabled={busy}
          onClick={() => setVersion((v) => v + 1)}
        >
          Refresh
        </button>
        <label>
          <input
            type="checkbox"
            checked={auto}
            disabled={busy}
            onChange={(e) => setAuto(e.target.checked)}
          />{" "}
          Refresh every 5 seconds
        </label>
      </div>
      <p className="admin-muted">
        Server permissions determine which sessions and statistics are visible.
        Kill Query cancels the current statement and keeps its connection open.
      </p>
      {section === "Processes" && session.config.driver !== "sqlite" && (
        <div className="admin-row">
          <label>
            Process ID{" "}
            <input
              inputMode="numeric"
              value={pid}
              onChange={(e) => {
                setPid(e.target.value.replace(/\D/g, ""));
                setConfirm(false);
              }}
            />
          </label>
          <label>
            <input
              type="checkbox"
              checked={confirm}
              onChange={(e) => setConfirm(e.target.checked)}
            />{" "}
            Cancel this server query
          </label>
          <button
            className="button danger"
            disabled={busy || !pid || !confirm}
            onClick={() => void kill()}
          >
            Kill query
          </button>
        </div>
      )}
      {busy && <p role="status">Reading server…</p>}
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
      <AdminResult
        result={result}
        onRow={
          section === "Processes"
            ? (row) => {
                const index =
                  result?.columns.findIndex(
                    (c) =>
                      c.toLowerCase() === "pid" || c.toLowerCase() === "id",
                  ) ?? -1;
                if (index >= 0) {
                  setPid(String(row[index]));
                  setConfirm(false);
                }
              }
            : undefined
        }
      />
    </>
  );
}
