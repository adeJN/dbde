import { useEffect, useRef, useState } from "react";
import { Copy, Loader2, X, Check, CircleAlert } from "lucide-react";
import type { Session, TableInfo } from "../types";
import { suggestTableName, type TableClipboard } from "../lib/table-clipboard";
import * as api from "../lib/api";
import { useProcessReports, processFailure } from "../lib/process-reports";
import { ProcessReportCard } from "./ProcessReports";
import "./PasteTablesDialog.css";

export default function PasteTablesDialog({
  source,
  target,
  database,
  onClose,
  onDone,
}: {
  source: TableClipboard;
  target: Session;
  database: string;
  onClose: () => void;
  onDone: (count: number) => void;
}) {
  const [items, setItems] = useState(
    source.tables.map((table) => ({ table, name: table.name, copied: false })),
  );
  const itemsRef = useRef(items);
  itemsRef.current = items;
  const [data, setData] = useState(true);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const cancelRequested = useRef(false);
  const operationId = useRef<string>();
  const [currentIndex, setCurrentIndex] = useState<number>();
  const [started, setStarted] = useState(false);
  const [cancelling, setCancelling] = useState(false);
  const grouped = api.desktop && target.config.driver === "mysql";
  const [preparedCount, setPreparedCount] = useState(0);
  const [batchPhase, setBatchPhase] = useState("");
  const [batchStage, setBatchStage] = useState("");
  const [reportId, setReportId] = useState<string>();
  const [error, setError] = useState("");
  const root = useRef<HTMLElement>(null);
  const activeReport = useProcessReports((s) =>
    s.reports.find(
      (r) =>
        !!operationId.current &&
        (r.title === "Copy table" || r.title === "Copy table group") &&
        r.status === "running" &&
        r.operationId === operationId.current,
    ),
  );
  useEffect(() => {
    let active = true;
    const previous = document.activeElement as HTMLElement | null;
    api
      .schema(target.id, database)
      .then((tree) => {
        if (!active) return;
        const used = new Set(tree.tables.map((table) => table.name));
        const next = source.tables.map((table) => {
          const name = suggestTableName(table.name, used, target.config.driver);
          used.add(name);
          return { table, name, copied: false };
        });
        setItems(next);
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      previous?.isConnected && previous.focus();
    };
  }, [source, target.id, database, target.config.driver]);
  async function paste() {
    if (busyRef.current || loading) return;
    const current = itemsRef.current;
    const names = current.map((item) => item.name.trim());
    const limit =
      target.config.driver === "mysql"
        ? 64
        : target.config.driver === "postgres"
          ? 63
          : 128;
    const normalized =
      target.config.driver === "mysql"
        ? names.map((name) => name.toLowerCase())
        : names;
    if (
      names.some(
        (name) =>
          !name ||
          name.includes("\0") ||
          new TextEncoder().encode(name).length > limit,
      ) ||
      new Set(normalized).size !== names.length
    ) {
      setError(
        "Choose a nonempty, unique name within the database identifier length limit for each target table.",
      );
      return;
    }
    busyRef.current = true;
    cancelRequested.current = false;
    setBusy(true);
    setStarted(true);
    setCancelling(false);
    setError("");
    setPreparedCount(0);
    setBatchPhase("");
    setBatchStage("");
    let copied = current.filter((item) => item.copied).length;
    const reports = useProcessReports.getState();
    const reportId = reports.start(
      "Paste tables",
      `${source.database} → ${target.config.name} / ${database}`,
    );
    setReportId(reportId);
    try {
      if (grouped) {
        operationId.current = crypto.randomUUID();
        await api.pasteTables(
          source.connectionId,
          source.database,
          target.id,
          database,
          current.map((item, index) => ({
            table: item.table,
            target: { name: names[index], schema: database, kind: "table" },
          })),
          data,
          operationId.current,
          (progress) => {
            if (typeof progress.tables_copied === "number")
              setPreparedCount(progress.tables_copied);
            setCurrentIndex(progress.table_index);
            setBatchPhase(progress.phase ?? "");
            setBatchStage(progress.stage);
            reports.progress(reportId, progress.stage, progress.rows);
          },
        );
        copied = current.length;
        const next = current.map((item, index) => ({
          ...item,
          name: names[index],
          copied: true,
        }));
        itemsRef.current = next;
        setItems(next);
        setBatchPhase("complete");
      } else
        for (let index = 0; index < current.length; index++) {
          const item = current[index];
          if (cancelRequested.current)
            throw new Error("Copy cancelled. Completed tables are retained.");
          if (item.copied) continue;
          operationId.current = crypto.randomUUID();
          setCurrentIndex(index);
          reports.progress(
            reportId,
            `Copying ${item.table.name} → ${names[index]} (${copied}/${current.length} tables completed)`,
          );
          const destination: TableInfo = {
            name: names[index],
            schema:
              target.config.driver === "mysql" ? database : item.table.schema,
            kind: "table",
          };
          await api.pasteTable(
            source.connectionId,
            source.database,
            item.table,
            target.id,
            database,
            destination,
            data,
            operationId.current,
          );
          copied++;
          reports.progress(
            reportId,
            `${copied}/${current.length} tables completed`,
          );
          const next = itemsRef.current.map((row, rowIndex) =>
            rowIndex === index
              ? { ...row, name: names[index], copied: true }
              : row,
          );
          itemsRef.current = next;
          setItems(next);
        }
      reports.finish(
        reportId,
        "success",
        `${copied}/${current.length} tables copied successfully`,
      );
      onDone(copied);
    } catch (cause) {
      if (grouped) setBatchPhase("error");
      reports.finish(
        reportId,
        "error",
        `${copied}/${current.length} tables completed. ${processFailure(cause)} Completed tables are retained.`,
      );
      setError(
        grouped
          ? `The table group was not confirmed complete. ${String(cause)}`
          : `${copied} of ${current.length} tables copied. ${String(cause)} Already copied tables are skipped when retrying.`,
      );
    } finally {
      operationId.current = undefined;
      setCurrentIndex(undefined);
      busyRef.current = false;
      setBusy(false);
    }
  }
  const completed = items.filter((item) => item.copied).length;
  const progressMax = grouped ? items.length + 2 : items.length;
  const progressValue = grouped
    ? batchPhase === "complete"
      ? progressMax
      : preparedCount + (batchPhase === "publishing" ? 1 : 0)
    : completed;
  const percent = progressMax
    ? Math.floor((progressValue / progressMax) * 100)
    : 0;
  const currentItem =
    currentIndex === undefined ? undefined : items[currentIndex];
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(event) =>
        event.target === event.currentTarget && !busy && onClose()
      }
    >
      <section
        ref={root}
        className="modal paste-tables-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="paste-tables-title"
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) {
            event.stopPropagation();
            onClose();
          }
          if (event.key === "Tab") {
            const nodes = root.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled)",
            );
            if (!nodes?.length) return;
            if (event.shiftKey && document.activeElement === nodes[0]) {
              event.preventDefault();
              nodes[nodes.length - 1].focus();
            } else if (
              !event.shiftKey &&
              document.activeElement === nodes[nodes.length - 1]
            ) {
              event.preventDefault();
              nodes[0].focus();
            }
          }
        }}
      >
        <header>
          <div className="modal-icon">
            <Copy size={23} />
          </div>
          <button
            autoFocus
            className="icon-button"
            aria-label="Close paste dialog"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <h2 id="paste-tables-title">Paste tables</h2>
        <p>
          From {source.database} → {target.config.name} / {database}
        </p>
        {loading ? (
          <p role="status">Loading destination tables…</p>
        ) : (
          <fieldset disabled={busy} className="table-tools-fields">
            <div className="paste-table-names">
              {items.map((item, index) => (
                <label key={`${item.table.schema}.${item.table.name}`}>
                  {item.table.name} →
                  <input
                    aria-label={`Target name for ${item.table.name}`}
                    value={item.name}
                    disabled={item.copied}
                    onChange={(event) =>
                      setItems((old) =>
                        old.map((row, rowIndex) =>
                          rowIndex === index
                            ? { ...row, name: event.target.value }
                            : row,
                        ),
                      )
                    }
                  />
                  {item.copied && <small className="success">Copied</small>}
                </label>
              ))}
            </div>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={data}
                disabled={items.some((item) => item.copied)}
                onChange={(event) => setData(event.target.checked)}
              />
              Include all records
            </label>
            <p>
              Creates new tables without replacing existing tables. Columns and
              indexes are copied. For MySQL, MariaDB and TiDB, select all
              related tables: foreign keys are installed and validated before
              the group is published. Triggers, permissions and server-specific
              features require separate review. Existing tables are kept;
              matching names receive a new copy name.
            </p>
          </fieldset>
        )}
        {started && (
          <section
            className={`paste-progress${error ? " has-error" : ""}`}
            aria-label="Table copy progress"
          >
            <div className="paste-progress-heading">
              <strong>
                {busy
                  ? cancelling
                    ? "Cancelling copy…"
                    : "Copying tables…"
                  : error
                    ? "Copy interrupted"
                    : "Copy complete"}
              </strong>
              <span>{percent}%</span>
            </div>
            <progress
              aria-label={grouped ? "Copy steps completed" : "Tables copied"}
              max={progressMax || 1}
              value={progressValue}
            />
            <div className="paste-progress-summary">
              <span>
                {grouped && batchPhase !== "complete"
                  ? `${preparedCount} of ${items.length} tables prepared · ${error ? "publication not confirmed" : "relationships and publication pending"}`
                  : `${completed} of ${items.length} tables completed`}
              </span>
              {reportId && (
                <button
                  type="button"
                  onClick={() => useProcessReports.getState().showLog(reportId)}
                >
                  View log
                </button>
              )}
            </div>
            {grouped && batchStage && (
              <p className="paste-batch-stage" role="status">
                {batchStage}
              </p>
            )}
            {currentItem && (
              <div className="paste-current-table" role="status">
                <Loader2 size={14} className="spin" aria-hidden="true" />
                <div>
                  <strong>
                    {currentItem.table.name} → {currentItem.name.trim()}
                  </strong>
                  <small>
                    {cancelling
                      ? "Waiting for cancellation and cleanup…"
                      : (activeReport?.stage ??
                        (data
                          ? "Copying structure and records…"
                          : "Copying structure…"))}
                    {activeReport?.rows !== undefined &&
                      ` · ${activeReport.rows.toLocaleString()} rows copied`}
                  </small>
                </div>
              </div>
            )}
            <ul
              className="paste-progress-tables"
              aria-label="Copy status by table"
            >
              {items.map((item, index) => (
                <li key={`${item.table.schema}.${item.table.name}`}>
                  {item.copied ? (
                    <Check
                      size={13}
                      className="paste-status-success"
                      aria-hidden="true"
                    />
                  ) : busy && index === currentIndex ? (
                    <Loader2 size={13} className="spin" aria-hidden="true" />
                  ) : error &&
                    items.findIndex((row) => !row.copied) === index ? (
                    <CircleAlert size={13} aria-hidden="true" />
                  ) : (
                    <span className="paste-status-dot" aria-hidden="true" />
                  )}
                  <span title={item.name}>{item.name}</span>
                  <small>
                    {item.copied
                      ? "Completed"
                      : busy && index === currentIndex
                        ? cancelling
                          ? "Cancelling"
                          : "Copying"
                        : error &&
                            items.findIndex((row) => !row.copied) === index
                          ? "Interrupted"
                          : grouped && error
                            ? "Not published"
                            : grouped && index < preparedCount
                              ? "Prepared"
                              : "Pending"}
                  </small>
                </li>
              ))}
            </ul>
            <small className="paste-progress-hint">
              {grouped
                ? "Progress counts prepared tables, relationship validation and final publication. Tables are published only after validation succeeds."
                : "Progress measures completed tables. Record totals may be unavailable while a table is copying."}
            </small>
          </section>
        )}
        {busy && activeReport && (
          <div className="paste-process-progress">
            <ProcessReportCard report={activeReport} />
          </div>
        )}
        {error && (
          <p role="alert" className="form-message error">
            {error}
          </p>
        )}
        <footer>
          <button
            className="button secondary"
            disabled={busy && cancelling}
            onClick={() => {
              if (!busy) return onClose();
              cancelRequested.current = true;
              setCancelling(true);
              if (operationId.current)
                void api
                  .cancelOperation(operationId.current)
                  .catch((cause) => setError(String(cause)));
            }}
          >
            {busy ? (cancelling ? "Cancelling…" : "Cancel copy") : "Cancel"}
          </button>
          <button
            className="button primary"
            disabled={busy || loading}
            onClick={() => void paste()}
          >
            {busy && <Loader2 size={14} className="spin" />}
            {busy ? "Copying…" : "Paste tables"}
          </button>
        </footer>
      </section>
    </div>
  );
}
