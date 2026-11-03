import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  processFailure,
  reportText,
  useProcessReports,
} from "./process-reports";
beforeEach(() =>
  useProcessReports.setState({
    reports: [],
    notifications: [],
    selectedId: undefined,
    open: false,
  }),
);
describe("process reports", () => {
  it("keeps completion and real row counts available after the operation closes", () => {
    const store = useProcessReports.getState();
    const id = store.start("Copy table", "source → destination");
    store.progress(id, "Copying records", 250);
    store.finish(id, "success", "Completed successfully");
    store.progress(id, "late event", 1);
    const report = useProcessReports.getState().reports[0];
    expect(report.rows).toBe(250);
    expect(report.status).toBe("success");
    expect(useProcessReports.getState().open).toBe(false);
    expect(useProcessReports.getState().notifications[0].reportId).toBe(id);
    expect(reportText(report)).toContain("250 rows");
    expect(reportText(report)).toContain("Duration:");
  });
  it("bounds completed history and logs while retaining running jobs", () => {
    const store = useProcessReports.getState();
    const active = store.start("Running");
    const ids = Array.from({ length: 80 }, () => store.start("Copy table"));
    for (const id of ids) store.finish(id, "success", "Done");
    for (let i = 0; i < 600; i++) store.progress(active, `Stage ${i}`, i);
    expect(useProcessReports.getState().reports).toHaveLength(51);
    expect(
      useProcessReports.getState().reports.find((r) => r.id === active)?.log
        .length,
    ).toBeLessThanOrEqual(250);
    store.clear();
    expect(useProcessReports.getState().reports.map((r) => r.id)).toEqual([
      active,
    ]);
  });
  it("does not copy SQL or sensitive row values from database errors into reports", () => {
    const safe = processFailure(
      "Duplicate entry 'private-user-password' for key email",
    );
    expect(safe).not.toContain("private-user-password");
    expect(safe).toContain("conflicting");
    expect(processFailure("EOF")).toContain("Verify the destination");
  });
});

it("does not merge unrelated actions completed close together", () => {
  const s = useProcessReports.getState();
  const id = s.start("Export customers");
  s.finish(id, "success", "Done");
  s.notify("Saved table profile", "success");
  const state = useProcessReports.getState();
  expect(state.notifications).toHaveLength(2);
  expect(state.notifications[0].reportId).not.toBe(id);
});
it("keeps an older notification's log accessible after history eviction and new completions", () => {
  vi.useFakeTimers();
  try {
    vi.setSystemTime(1000);
    const s = useProcessReports.getState();
    const id = s.start("First failure");
    s.finish(id, "error", "Failed first");
    for (let i = 0; i < 55; i++) {
      vi.setSystemTime((i + 2) * 1000);
      const next = s.start("Later");
      s.finish(next, "error", "Failed");
    }
    expect(useProcessReports.getState().reports.some((r) => r.id === id)).toBe(
      false,
    );
    s.showLog(id);
    s.dismiss(id);
    expect(
      useProcessReports.getState().reports.find((r) => r.id === id)?.stage,
    ).toBe("Failed first");
    vi.setSystemTime(100000);
    const next = s.start("Newest");
    s.finish(next, "success", "Done");
    expect(
      useProcessReports.getState().reports.find((r) => r.id === id)?.finished,
    ).toBe(1000);
    s.setOpen(false);
    expect(useProcessReports.getState().reports.some((r) => r.id === id)).toBe(
      false,
    );
  } finally {
    vi.useRealTimers();
  }
});

it("keeps safe copy dependency and validation diagnostics actionable", () => {
  expect(
    processFailure(
      "Copy dependency missing: include table source.parent in the selection",
    ),
  ).toContain("source.parent");
  expect(
    processFailure(
      "Foreign key validation failed: child.parent_fk. Check parent keys; no completed group was published",
    ),
  ).toContain("child.parent_fk");
  expect(
    processFailure("Cannot add child: secret record value foreign key error"),
  ).not.toContain("secret record");
});

it.each(["finish", "notify"])(
  "bounds notification snapshots during 1,000 failures through %s",
  (method) => {
    const store = useProcessReports.getState();
    for (let i = 0; i < 1000; i++) {
      if (method === "finish") {
        const id = store.start(`Failure ${i}`);
        store.finish(id, "error", "Failed");
      } else store.notify(`Failure ${i}`, "error");
    }
    const state = useProcessReports.getState();
    expect(state.reports).toHaveLength(50);
    expect(state.notifications).toHaveLength(101);
    expect(state.notifications.filter((n) => n.report)).toHaveLength(100);
    const summary = state.notifications.find((n) => n.groupedCount);
    expect(summary?.groupedCount).toBe(900);
    expect(summary?.tone).toBe("warning");
    const newest = state.notifications[0];
    store.showLog(newest.reportId);
    expect(useProcessReports.getState().selectedId).toBe(newest.reportId);
    store.dismiss(summary!.id);
    expect(useProcessReports.getState().notifications).toHaveLength(100);
  },
);
