import { create } from "zustand";

export interface ProcessReport {
  id: string;
  title: string;
  context: string;
  operationId?: string;
  started: number;
  finished?: number;
  status: "running" | "success" | "warning" | "error" | "cancelled";
  rows?: number;
  stage: string;
  log: { at: number; text: string }[];
}
export interface ProcessNotification {
  id: string;
  reportId: string;
  text: string;
  tone: "success" | "warning" | "error" | "info";
  report?: ProcessReport;
  /** Older feedback is grouped once the bounded notification queue is full. */
  groupedCount?: number;
}
interface Reports {
  notifications: ProcessNotification[];
  selectedId?: string;
  notify: (
    text: string,
    tone?: ProcessNotification["tone"],
    reportId?: string,
  ) => void;
  dismiss: (id: string) => void;
  showLog: (id: string) => void;
  reports: ProcessReport[];
  open: boolean;
  setOpen: (open: boolean) => void;
  start: (title: string, context?: string, operationId?: string) => string;
  progress: (id: string, stage: string, rows?: number) => void;
  finish: (
    id: string,
    status: Exclude<ProcessReport["status"], "running">,
    message: string,
  ) => void;
  clear: () => void;
}
let sequence = 0;
export const MAX_PROCESS_NOTIFICATIONS = 100;
function boundedNotifications(
  notification: ProcessNotification,
  previous: ProcessNotification[],
): ProcessNotification[] {
  const summary = previous.find((n) => n.groupedCount !== undefined);
  const queue = [
    notification,
    ...previous.filter(
      (n) => n.id !== notification.id && n.groupedCount === undefined,
    ),
  ];
  const excess = queue.slice(MAX_PROCESS_NOTIFICATIONS);
  const groupedCount = (summary?.groupedCount ?? 0) + excess.length;
  const groupedFailures = excess.filter(
    (n) => n.tone === "error" || n.tone === "warning",
  ).length;
  return [
    ...queue.slice(0, MAX_PROCESS_NOTIFICATIONS),
    ...(groupedCount
      ? [
          {
            id: "notification-overflow",
            reportId: "",
            groupedCount,
            text: `${groupedCount} older notifications grouped. The latest ${MAX_PROCESS_NOTIFICATIONS} notifications and 50 recent reports are retained.`,
            tone: (groupedFailures || summary?.tone === "warning"
              ? "warning"
              : "info") as ProcessNotification["tone"],
          },
        ]
      : []),
  ];
}
function retained(
  reports: ProcessReport[],
  pinnedId?: string,
): ProcessReport[] {
  const completed = new Set(
    reports
      .filter((r) => r.status !== "running" && r.id !== pinnedId)
      .sort((a, b) => (b.finished ?? 0) - (a.finished ?? 0))
      .slice(0, 50)
      .map((r) => r.id),
  );
  return reports.filter(
    (r) => r.status === "running" || r.id === pinnedId || completed.has(r.id),
  );
}
// Session-only, bounded history. Never store SQL, credentials or record contents.
export const useProcessReports = create<Reports>((set) => ({
  reports: [],
  notifications: [],
  open: false,
  dismiss: (id) =>
    set((s) => ({ notifications: s.notifications.filter((n) => n.id !== id) })),
  showLog: (id) =>
    set((s) => {
      const report =
        s.reports.find((r) => r.id === id) ??
        s.notifications.find((n) => n.reportId === id)?.report;
      return report
        ? {
            open: true,
            selectedId: id,
            reports: retained(
              [report, ...s.reports.filter((r) => r.id !== id)],
              id,
            ),
          }
        : { open: true, selectedId: undefined };
    }),
  notify: (text, tone = "error", reportId) => {
    if (!text) return;
    // Only explicit operation IDs may link feedback to an existing report.
    set((s) => {
      const recent = reportId
        ? s.reports.find((r) => r.id === reportId)
        : undefined;
      const id = recent?.id ?? `process-${++sequence}`;
      const at = Date.now();
      const report: ProcessReport = {
        id,
        title: "Workspace action",
        context: "",
        started: at,
        finished: at,
        status:
          tone === "error"
            ? "error"
            : tone === "warning"
              ? "warning"
              : "success",
        stage: tone === "error" ? processFailure(text) : text,
        log: [{ at, text: tone === "error" ? processFailure(text) : text }],
      };
      return {
        reports: recent
          ? s.reports
          : retained([report, ...s.reports], s.open ? s.selectedId : undefined),
        notifications: boundedNotifications(
          { id, reportId: id, text, tone, report: recent ?? report },
          s.notifications,
        ),
      };
    });
  },
  setOpen: (open) =>
    set((s) => ({
      open,
      selectedId: open ? s.selectedId : undefined,
      reports: retained(s.reports, open ? s.selectedId : undefined),
    })),
  start: (title, context = "", operationId) => {
    const id = `process-${++sequence}`,
      started = Date.now();
    set((s) => ({
      reports: retained(
        [
          {
            id,
            title,
            context,
            operationId,
            started,
            status: "running",
            stage: "Starting",
            log: [{ at: started, text: "Started" }],
          },
          ...s.reports,
        ],
        s.open ? s.selectedId : undefined,
      ),
    }));
    return id;
  },
  progress: (id, stage, rows) =>
    set((s) => ({
      reports: s.reports.map((r) => {
        if (r.id !== id || r.status !== "running") return r;
        const last = r.log[r.log.length - 1];
        const text =
          rows === undefined
            ? stage
            : `${stage} · ${rows.toLocaleString()} rows`;
        const append =
          stage !== r.stage || !last || Date.now() - last.at >= 500;
        return {
          ...r,
          stage,
          rows: rows ?? r.rows,
          log: append
            ? [
                r.log[0],
                ...r.log.slice(1).slice(-248),
                { at: Date.now(), text },
              ]
            : r.log,
        };
      }),
    })),
  finish: (id, status, message) =>
    set((s) => {
      const report = s.reports.find((r) => r.id === id);
      if (!report || report.status !== "running") return {};
      const finished: ProcessReport = {
        ...report,
        status,
        stage: message,
        finished: Date.now(),
        log: [
          report.log[0],
          ...report.log.slice(1).slice(-248),
          { at: Date.now(), text: message },
        ],
      };
      return {
        notifications: boundedNotifications(
          {
            id,
            reportId: id,
            text: `${report.title}: ${message}`,
            tone: status === "cancelled" ? ("info" as const) : status,
            report: finished,
          },
          s.notifications,
        ),
        reports: retained(
          [finished, ...s.reports.filter((r) => r.id !== id)],
          s.open ? s.selectedId : undefined,
        ),
      };
    }),
  clear: () =>
    set((s) => ({
      reports: s.reports.filter((r) => r.status === "running"),
      notifications: [],
      selectedId: undefined,
    })),
}));
export function reportText(report: ProcessReport): string {
  return [
    report.title,
    report.context,
    `Status: ${report.status}`,
    ...(report.rows === undefined ? [] : [`Rows: ${report.rows}`]),
    `Duration: ${(((report.finished ?? Date.now()) - report.started) / 1000).toFixed(1)} s`,
    ...report.log.map(
      (l) => `${new Date(l.at).toLocaleTimeString()}  ${l.text}`,
    ),
  ]
    .filter(Boolean)
    .join("\n");
}
export function processFailure(cause: unknown): string {
  const text = String(cause);
  if (/^Copy dependency missing:/i.test(text)) return text.slice(0, 500);
  if (/^Foreign key validation failed:/i.test(text))
    return text.split("; no completed group")[0].slice(0, 500);
  if (/cancel|abort/i.test(text))
    return "Operation cancelled. Verify any work already completed.";
  if (/EOF|connection|timed out|network|SSH/i.test(text))
    return "Connection interrupted. Verify the destination before retrying; work may already have completed.";
  if (/denied|permission|privilege/i.test(text))
    return "Permission denied. Check the account's access rights.";
  if (/duplicate|already exists|unique/i.test(text))
    return "A conflicting table or unique value blocked the operation. Review any work already completed before retrying.";
  if (/foreign key|constraint/i.test(text))
    return "A database constraint blocked the operation. Review the operation dialog for details.";
  return "Operation failed. Review the operation dialog for details before retrying.";
}
