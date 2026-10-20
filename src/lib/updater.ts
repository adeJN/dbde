import { Channel, invoke, isTauri } from "@tauri-apps/api/core";
import { version } from "../../package.json";
import type { QueryTab } from "../types";
import { pendingCount } from "./staged";

export interface UpdateStatus {
  currentVersion: string;
  configured: boolean;
}
export interface AvailableUpdate {
  currentVersion: string;
  version: string;
  notes: string;
}
export type UpdateProgress =
  | { event: "download"; downloaded: number; total: number | null }
  | { event: "installing" };

export const desktopUpdates = () => isTauri();
export const updateStatus = (): Promise<UpdateStatus> =>
  isTauri()
    ? invoke("dbde_update_status")
    : Promise.resolve({ currentVersion: version, configured: false });
export interface UpdateUnavailable {
  unavailable: true;
}
export const checkUpdate = (): Promise<
  AvailableUpdate | UpdateUnavailable | null
> => invoke("dbde_check_update");
export const installUpdate = (onProgress: (event: UpdateProgress) => void) => {
  const onEvent = new Channel<UpdateProgress>();
  onEvent.onmessage = onProgress;
  return invoke<void>("dbde_install_update", { onEvent });
};

export function updateBlocker(
  tabs: QueryTab[],
  connections: number,
): string | null {
  if (tabs.some((tab) => tab.running))
    return "Wait for running queries to finish before installing.";
  if (
    tabs.some(
      (tab) =>
        tab.staged && (pendingCount(tab.staged) > 0 || tab.staged.transaction),
    )
  )
    return "Save or discard table edits and finish transactions before installing.";
  if (
    tabs.some(
      (tab) =>
        !tab.tableIdentity &&
        tab.kind !== "database" &&
        tab.query.trim() &&
        tab.query !== tab.savedQuerySql,
    )
  )
    return "Save your SQL queries before installing the update.";
  if (connections > 0)
    return "Save your work, then close all connections and detached table windows before installing.";
  return null;
}
