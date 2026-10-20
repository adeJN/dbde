import { useEffect, useRef, useState } from "react";
import { Copy, Wrench, X } from "lucide-react";
import { maintainText, type MaintainResult } from "../lib/maintain";

/** The server's per-table messages after a Maintain operation (Table, Op, Msg_type, Msg_text). */
export default function MaintainResultDialog({
  label,
  database,
  result,
  onCopy,
  onClose,
}: {
  label: string;
  database: string;
  result: MaintainResult;
  onCopy: (text: string) => Promise<void>;
  onClose: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [status, setStatus] = useState<{ text: string; error?: boolean }>();
  const problems = result.rows.filter((row) =>
    ["error", "warning"].includes(row.msg_type.toLowerCase()),
  ).length;
  const tables = new Set(result.rows.map((row) => row.table)).size;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current
      ?.querySelector<HTMLElement>(".maintain-results-scroll")
      ?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={root}
        className="modal ddl-dialog maintain-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="maintain-title"
        aria-describedby="maintain-summary"
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
            <Wrench size={20} />
          </div>
          <button
            className="icon-button"
            aria-label="Close maintenance results"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <h2 id="maintain-title">
          {label} results
          <small>
            {database} · {tables} {tables === 1 ? "table" : "tables"} ·{" "}
            {result.execution_ms.toLocaleString("en-US", {
              maximumFractionDigits: 0,
            })}{" "}
            ms
          </small>
        </h2>
        <p
          id="maintain-summary"
          className={
            problems ? "maintain-summary problems" : "maintain-summary"
          }
          role="status"
        >
          {problems
            ? `${problems} ${problems === 1 ? "message needs" : "messages need"} attention.`
            : "Completed without errors."}
        </p>
        <pre className="ddl-code maintain-sql" aria-label="Statements run">
          {result.statements.join(";\n")}
        </pre>
        <div
          className="maintain-results-scroll"
          tabIndex={0}
          aria-label="Maintenance messages"
        >
          <table className="plan-grid">
            <thead>
              <tr>
                <th scope="col">Table</th>
                <th scope="col">Op</th>
                <th scope="col">Msg_type</th>
                <th scope="col">Msg_text</th>
              </tr>
            </thead>
            <tbody>
              {result.rows.map((row, index) => (
                <tr
                  key={index}
                  className={`maintain-${row.msg_type.toLowerCase().replace(/[^a-z]/g, "")}`}
                >
                  <td>{row.table}</td>
                  <td>{row.op}</td>
                  <td>{row.msg_type}</td>
                  <td>{row.msg_text}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
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
            onClick={async () => {
              try {
                await onCopy(maintainText(result));
                setStatus({ text: "Results copied." });
              } catch (cause) {
                setStatus({ text: String(cause), error: true });
              }
            }}
          >
            <Copy size={14} /> Copy results
          </button>
          <button className="button primary" onClick={onClose}>
            Close
          </button>
        </footer>
      </section>
    </div>
  );
}
