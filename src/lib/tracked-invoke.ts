import { Channel, invoke } from "@tauri-apps/api/core";
import { useProcessReports, processFailure } from "./process-reports";
import { useWorkspace } from "../store";
const titles: Record<string, string> = {
  dbde_copy_table: "Copy table",
  dbde_copy_tables: "Copy table group",
  dbde_transfer_records: "Transfer records",
  dbde_dump_sql: "SQL dump",
  dbde_export_table: "Export table",
  dbde_export_rows: "Export rows",
  dbde_import_run: "Import records",
  dbde_manage_database: "Manage database",
  dbde_maintain_tables: "Table maintenance",
  dbde_create_table: "Create table",
  dbde_alter_table_fields: "Alter table",
  dbde_execute_query: "Execute SQL",
  dbde_connect: "Open connection",
  dbde_test_connection: "Test connection",
  dbde_drop_table: "Delete table",
  dbde_delete_rows: "Delete records",
  dbde_clear_table: "Empty / truncate table",
  dbde_delete_profile: "Delete saved connection",
  dbde_save_profile: "Save connection",
  dbde_update_cell: "Update record",
  dbde_raw_cell: "Update record expression",
  dbde_insert_record: "Add record",
  dbde_insert_records: "Add records",
  dbde_apply_changes: "Save record changes",
  dbde_rename_table: "Rename table",
};
export async function trackedInvoke<T>(
  command: string,
  args?: Record<string, unknown>,
): Promise<T> {
  const changes = args?.changes as { kind?: string }[] | undefined;
  const deletes = Array.isArray(changes)
    ? changes.filter((c) => c.kind === "delete").length
    : 0;
  const title =
    command === "dbde_apply_changes" && deletes
      ? "Apply record changes with deletions"
      : command === "dbde_object_action" && !args?.preview
        ? args?.action === "drop"
          ? "Delete database object"
          : "Update database object"
        : command === "dbde_manage_database" && args?.action === "delete"
          ? "Delete database"
          : titles[command];
  if (!title || (command === "dbde_execute_query" && !args?.sessionId))
    return args === undefined ? invoke<T>(command) : invoke<T>(command, args);
  const reports = useProcessReports.getState();
  const table = args?.table as { name?: string } | undefined;
  const destination = (args?.destination ??
    (args?.destinationDatabase
      ? {
          database: args.destinationDatabase,
          connectionId: args.destinationConnectionId,
        }
      : undefined)) as { database?: string; connectionId?: string } | undefined;
  const sessions = useWorkspace.getState().sessions;
  const connectionName = sessions.find((s) => s.id === args?.connectionId)
    ?.config.name;
  const targetName = sessions.find((s) => s.id === destination?.connectionId)
    ?.config.name;
  const context = [
    connectionName,
    (args?.config as { name?: string } | undefined)?.name,
    args?.database,
    table?.name,
    (args?.object as { name?: string } | undefined)?.name,
    destination?.database
      ? `→ ${targetName ? `${targetName} / ` : ""}${destination.database}`
      : "",
  ]
    .filter((x) => typeof x === "string" && x)
    .join(" / ");
  const longOperation = /dbde_(copy_tables?|transfer_records|dump_sql)/.test(
    command,
  );
  const operationId = longOperation
    ? typeof args?.operationId === "string"
      ? args.operationId
      : crypto.randomUUID()
    : undefined;
  const id = reports.start(title, context, operationId);
  if (deletes) reports.progress(id, `${deletes} record deletions requested`);
  let payload = operationId ? { ...args, operationId } : args;
  const previous = args?.onProgress as
    Channel<{ rows: number; stage?: string }> | undefined;
  if (previous) {
    const receive = previous.onmessage;
    previous.onmessage = (message) => {
      receive?.(message);
      reports.progress(id, message.stage ?? "Processing records", message.rows);
    };
  } else if (/dbde_(copy_tables?|transfer_records|dump_sql)/.test(command)) {
    const channel = new Channel<{ rows?: number; stage: string }>();
    channel.onmessage = (message) =>
      reports.progress(
        id,
        message.stage,
        typeof message.rows === "number" ? message.rows : undefined,
      );
    payload = { ...payload, onProgress: channel };
  }
  try {
    const result = await invoke<T>(command, payload);
    if (
      typeof result === "number" &&
      /delete_rows|clear_table|apply_changes/.test(command)
    ) {
      reports.progress(id, "Affected records", result);
    }
    const summary = result as {
      rows?: number;
      cancelled?: boolean;
      inserted?: number;
      updated?: number;
      skipped?: number;
      failed?: number;
    } | null;
    if (typeof summary?.rows === "number")
      reports.progress(id, "Processed records", summary.rows);
    const cancelled =
      (result === null && /export|import/.test(command)) || summary?.cancelled;
    const partial = command === "dbde_import_run" && (summary?.failed ?? 0) > 0;
    const importSummary =
      command === "dbde_import_run" && summary
        ? `${summary.rows ?? 0} rows read · ${summary.inserted ?? 0} inserted · ${summary.updated ?? 0} updated · ${summary.skipped ?? 0} skipped · ${summary.failed ?? 0} failed`
        : undefined;
    reports.finish(
      id,
      cancelled ? "cancelled" : partial ? "warning" : "success",
      cancelled ? "Cancelled" : (importSummary ?? "Completed successfully"),
    );
    return result;
  } catch (cause) {
    const connectionFailure = /dbde_(connect|test_connection)$/.test(command);
    const message = connectionFailure
      ? /host key|fingerprint|known_hosts/i.test(String(cause))
        ? "SSH server identity could not be verified. Review the SSH host key settings."
        : /authentication|access denied|password/i.test(String(cause))
          ? "Connection authentication failed. Check the saved credentials."
          : "Connection could not be established. Check the network, server and SSH availability, then retry."
      : processFailure(cause);
    reports.finish(
      id,
      /cancel|abort/i.test(String(cause)) ? "cancelled" : "error",
      message,
    );
    throw cause;
  }
}
