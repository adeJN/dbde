import { memo, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  ListChecks,
  Loader2,
  CircleCheck,
  CircleAlert,
  Copy,
  X,
  Trash2,
} from "lucide-react";
import {
  useProcessReports,
  reportText,
  type ProcessReport,
  type ProcessNotification,
} from "../lib/process-reports";
import { writeClipboard } from "../lib/clipboard";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
import "./ProcessReports.css";

export const ProcessReportCard = memo(function ProcessReportCard({
  report,
  now = Date.now(),
  selected = false,
}: {
  report: ProcessReport;
  now?: number;
  selected?: boolean;
}) {
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState(false);
  return (
    <article
      data-report-id={report.id}
      className={`process-report ${report.status}${selected ? " selected" : ""}`}
    >
      <header>
        {report.status === "running" ? (
          <Loader2 size={15} className="spin" />
        ) : report.status === "success" ? (
          <CircleCheck size={15} />
        ) : (
          <CircleAlert size={15} />
        )}
        <strong>{report.title}</strong>
        <span className="process-status">{report.status}</span>
        <span>
          {Math.max(
            0,
            ((report.finished ?? now) - report.started) / 1000,
          ).toFixed(1)}{" "}
          s
        </span>
      </header>
      {report.context && <p className="process-context">{report.context}</p>}
      <p className="process-stage" role="status">
        {report.stage}
        {report.rows !== undefined && (
          <> · {report.rows.toLocaleString()} rows</>
        )}
      </p>
      <details
        open={
          selected || report.status === "error" || report.status === "warning"
        }
      >
        <summary>
          View log <span>{report.log.length} entries</span>
        </summary>
        <ol>
          {report.log.map((entry, i) => (
            <li key={`${entry.at}-${i}`}>
              <time>{new Date(entry.at).toLocaleTimeString()}</time>
              <span>{entry.text}</span>
            </li>
          ))}
        </ol>
      </details>
      {report.status === "running" && report.operationId && (
        <button
          className="button subtle"
          onClick={() => {
            void import("../lib/api")
              .then((api) => api.cancelOperation(report.operationId!))
              .then(() =>
                useProcessReports
                  .getState()
                  .progress(
                    report.id,
                    "Cancellation requested; checking destination and cleaning up",
                  ),
              )
              .catch((cause) =>
                useProcessReports.getState().notify(String(cause)),
              );
          }}
        >
          Cancel operation
        </button>
      )}
      <button
        className="button subtle process-copy"
        onClick={() =>
          void writeClipboard(reportText(report))
            .then(() => {
              setCopied(true);
              setCopyError(false);
            })
            .catch(() => setCopyError(true))
        }
      >
        <Copy size={12} />
        {copyError
          ? "Copy failed — try again"
          : copied
            ? "Log copied"
            : "Copy log"}
      </button>
    </article>
  );
});
function ProcessToast({ notification }: { notification: ProcessNotification }) {
  const dismiss = () => useProcessReports.getState().dismiss(notification.id);
  const timer = useAutoDismiss(
    notification,
    dismiss,
    notification.tone === "success" || notification.tone === "info",
  );
  return (
    <article
      {...timer}
      className={`process-toast ${notification.tone}`}
      role={
        notification.tone === "error" || notification.tone === "warning"
          ? "alert"
          : "status"
      }
    >
      {notification.tone === "error" || notification.tone === "warning" ? (
        <CircleAlert size={18} />
      ) : (
        <CircleCheck size={18} />
      )}
      <div className="process-toast-content">
        <strong>
          {notification.tone === "error"
            ? "Gagal"
            : notification.tone === "warning"
              ? "Selesai dengan peringatan"
              : notification.tone === "success"
                ? "Berhasil"
                : "Informasi"}
        </strong>
        <p>{notification.text}</p>
        <button
          className="process-toast-log"
          onClick={() => {
            useProcessReports.getState().showLog(notification.reportId);
            dismiss();
          }}
        >
          {notification.groupedCount ? "Buka reports" : "Lihat log"}{" "}
          <ListChecks size={13} />
        </button>
      </div>
      <button
        className="icon-button"
        onClick={dismiss}
        aria-label={
          notification.tone === "error"
            ? "Dismiss error"
            : "Dismiss notification"
        }
      >
        <X size={14} />
      </button>
    </article>
  );
}
export default function ProcessReports() {
  const trigger = useRef<HTMLButtonElement>(null);
  const panel = useRef<HTMLElement>(null);
  const focusOnOpen = useRef(false);
  const reports = useProcessReports((s) => s.reports);
  const open = useProcessReports((s) => s.open);
  const notifications = useProcessReports((s) => s.notifications);
  const selectedId = useProcessReports((s) => s.selectedId);
  const running = reports.filter((r) => r.status === "running").length;
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    if (open && focusOnOpen.current) {
      panel.current?.focus();
      focusOnOpen.current = false;
    }
  }, [open]);
  useEffect(() => {
    if (!open || !selectedId) return;
    const card = panel.current?.querySelector(
      `[data-report-id="${selectedId}"]`,
    );
    card?.scrollIntoView?.({ block: "nearest" });
    panel.current?.focus();
  }, [open, selectedId]);
  const close = () => {
    useProcessReports.getState().setOpen(false);
    trigger.current?.focus();
  };
  useEffect(() => {
    if (!open || !running) return;
    const timer = window.setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [open, running]);
  return (
    <>
      <button
        ref={trigger}
        className={`icon-button process-reports-toggle${running ? " has-running" : ""}`}
        aria-label="Process reports"
        title="Process reports"
        aria-expanded={open}
        aria-controls="process-reports-panel"
        onClick={() => {
          focusOnOpen.current = !open;
          useProcessReports.getState().setOpen(!open);
        }}
      >
        <ListChecks size={18} />
        {running > 0 && <span>{running}</span>}
      </button>
      {notifications.length > 0 &&
        createPortal(
          <section className="process-toasts" aria-label="Action notifications">
            {notifications.map((notification) => (
              <ProcessToast key={notification.id} notification={notification} />
            ))}
          </section>,
          document.body,
        )}
      {open &&
        createPortal(
          <aside
            ref={panel}
            id="process-reports-panel"
            tabIndex={-1}
            onKeyDown={(event) => {
              if (event.key === "Escape") {
                event.stopPropagation();
                close();
              }
            }}
            className="process-reports-panel"
            role="region"
            aria-label="Process reports"
          >
            <header className="process-reports-header">
              <ListChecks size={17} />
              <div>
                <strong>Process reports</strong>
                <small>
                  {running ? `${running} running` : "Recent operations"} ·
                  session history
                </small>
              </div>
              <button
                className="icon-button"
                aria-label="Clear completed reports"
                title="Clear completed reports"
                disabled={!reports.some((r) => r.status !== "running")}
                onClick={() => useProcessReports.getState().clear()}
              >
                <Trash2 size={14} />
              </button>
              <button
                className="icon-button"
                aria-label="Close process reports"
                onClick={close}
              >
                <X size={16} />
              </button>
            </header>
            <div className="process-reports-list">
              {reports.length ? (
                reports.map((report) => (
                  <ProcessReportCard
                    key={report.id}
                    report={report}
                    now={report.status === "running" ? now : report.finished}
                    selected={selectedId === report.id}
                  />
                ))
              ) : (
                <p className="process-reports-empty">
                  Copy, transfer, import, export and other operations appear
                  here. The latest 50 completed reports are retained during this
                  session.
                </p>
              )}
            </div>
          </aside>,
          document.body,
        )}
    </>
  );
}
