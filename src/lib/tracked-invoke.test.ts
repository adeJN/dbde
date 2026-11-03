// @vitest-environment jsdom
import { beforeEach, expect, it, vi } from "vitest";
const { invoke } = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock("@tauri-apps/api/core", () => ({
  invoke,
  Channel: class {
    onmessage?: (message: unknown) => void;
  },
}));
import { trackedInvoke } from "./tracked-invoke";
import { useProcessReports } from "./process-reports";
beforeEach(() => {
  invoke.mockReset();
  useProcessReports.setState({
    reports: [],
    notifications: [],
    selectedId: undefined,
    open: false,
  });
});
it("receives copy phases and preserves reports after completion", async () => {
  let done!: () => void;
  invoke.mockImplementation(
    () =>
      new Promise<void>((resolve) => {
        done = resolve;
      }),
  );
  const pending = trackedInvoke("dbde_copy_table", {
    database: "source",
    table: { name: "records" },
    destination: { database: "target" },
  });
  const channel = invoke.mock.calls[0][1].onProgress;
  channel.onmessage({ stage: "Preparing", rows: null });
  expect(useProcessReports.getState().reports[0].rows).toBeUndefined();
  channel.onmessage({ stage: "Copying records", rows: 200 });
  expect(useProcessReports.getState().reports[0].rows).toBe(200);
  done();
  await pending;
  expect(useProcessReports.getState().reports[0].status).toBe("success");
});
it("keeps existing import/export progress callbacks and records failures without replay", async () => {
  const callback = vi.fn();
  const channel = { onmessage: callback };
  invoke.mockImplementation(async () => {
    channel.onmessage({ rows: 75 });
    throw new Error("connection EOF");
  });
  await expect(
    trackedInvoke("dbde_import_run", { onProgress: channel }),
  ).rejects.toThrow("EOF");
  expect(callback).toHaveBeenCalledWith({ rows: 75 });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(useProcessReports.getState().reports[0]).toMatchObject({
    status: "error",
    rows: 75,
  });
});
it("does not log background metadata queries", async () => {
  invoke.mockResolvedValue({ rows: [] });
  await trackedInvoke("dbde_execute_query", {
    query: "SELECT secret",
    database: "app",
  });
  expect(useProcessReports.getState().reports).toHaveLength(0);
});
it("reports deleted records without including keys or row contents", async () => {
  invoke.mockResolvedValue(3);
  await trackedInvoke("dbde_delete_rows", {
    database: "app",
    table: { name: "records" },
    keys: [{ secret: "never-log-this" }],
  });
  const report = useProcessReports.getState().reports[0];
  expect(report).toMatchObject({
    title: "Delete records",
    status: "success",
    rows: 3,
  });
  expect(JSON.stringify(report)).not.toContain("never-log-this");
});
it("logs database deletion and staged deletions while ignoring object previews", async () => {
  invoke.mockResolvedValue(undefined);
  await trackedInvoke("dbde_manage_database", {
    database: "app",
    action: "delete",
  });
  expect(useProcessReports.getState().reports[0].title).toBe("Delete database");
  await trackedInvoke("dbde_apply_changes", {
    changes: [{ kind: "delete", key: { id: 1 } }],
  });
  expect(useProcessReports.getState().reports[0].title).toContain("deletions");
  const count = useProcessReports.getState().reports.length;
  await trackedInvoke("dbde_object_action", { action: "drop", preview: true });
  expect(useProcessReports.getState().reports).toHaveLength(count);
});
it("reports connection failures without suggesting data was written", async () => {
  invoke.mockRejectedValue(new Error("SSH connection timed out"));
  await expect(
    trackedInvoke("dbde_connect", {
      config: { name: "Server", password: "secret" },
    }),
  ).rejects.toThrow("timed out");
  const report = useProcessReports.getState().reports[0];
  expect(report.stage).toContain("Connection could not be established");
  expect(report.stage).not.toContain("committed");
  expect(JSON.stringify(report)).not.toContain("secret");
});

it("reports partial imports as warnings with real result counts", async () => {
  invoke.mockResolvedValue({
    rows: 3,
    inserted: 2,
    updated: 0,
    skipped: 0,
    failed: 1,
  });
  await trackedInvoke("dbde_import_run", {});
  const state = useProcessReports.getState();
  expect(state.reports[0].status).toBe("warning");
  expect(state.reports[0].stage).toContain("2 inserted");
  expect(state.reports[0].stage).toContain("1 failed");
  expect(state.notifications[0].tone).toBe("warning");
});
it("preserves group progress callbacks and the cancellation ID in its report", async () => {
  const callback = vi.fn();
  const channel = { onmessage: callback };
  invoke.mockImplementation(async (_command, args) => {
    args.onProgress.onmessage({
      stage: "Validating foreign key child.parent",
      tables_copied: 2,
      phase: "relations",
    });
  });
  await trackedInvoke("dbde_copy_tables", {
    connectionId: "source",
    database: "source_db",
    destinationConnectionId: "target",
    destinationDatabase: "dest_db",
    operationId: "group-operation",
    onProgress: channel,
  });
  expect(invoke).toHaveBeenCalledTimes(1);
  expect(callback).toHaveBeenCalledWith({
    stage: "Validating foreign key child.parent",
    tables_copied: 2,
    phase: "relations",
  });
  const report = useProcessReports.getState().reports[0];
  expect(report).toMatchObject({
    title: "Copy table group",
    status: "success",
    operationId: "group-operation",
  });
  expect(report.context).toContain("dest_db");
  expect(report.log.some((entry) => entry.text.includes("child.parent"))).toBe(
    true,
  );
});
