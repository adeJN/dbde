import type { AreaMenuItem } from "./AreaContextMenu";
import type { DbObject, Driver } from "../types";
import { OBJECT_LABELS, executable } from "../lib/db-objects";
import { tableShortcut, tableShortcutLabel } from "../lib/table-shortcuts";

export type ObjectAction =
  | "view"
  | "edit"
  | "execute"
  | "new"
  | "copy-name"
  | "drop"
  | "enable"
  | "disable"
  | "reset"
  | "refresh"
  | "refresh-concurrently"
  | "open-data";

/** What Enter or a click does: open a materialized view's data, otherwise its definition. */
export function defaultObjectAction(object: DbObject): ObjectAction {
  return object.kind === "materialized_view" ? "open-data" : "view";
}
/** List shortcuts shared with the table list: ⌘D edits (Design), ⌘C copies the name. */
export function objectShortcut(event: {
  key: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}): ObjectAction | "find" | "refresh" | undefined {
  const shortcut = tableShortcut(event);
  if (shortcut === "design") return "edit";
  if (shortcut === "copy") return "copy-name";
  if (shortcut === "new") return "new";
  if (shortcut === "find" || shortcut === "refresh") return shortcut;
  return undefined;
}
export function objectMenuItems(
  object: DbObject,
  driver: Driver,
  onAction: (action: ObjectAction) => void,
): AreaMenuItem[] {
  const one = OBJECT_LABELS[object.kind].one;
  const item = (
    label: string,
    action: ObjectAction,
    extra: Partial<AreaMenuItem> = {},
  ): AreaMenuItem => ({ label, action: () => onAction(action), ...extra });
  const items: AreaMenuItem[] = [];
  if (object.kind === "materialized_view")
    items.push(item("Open Data", "open-data", { shortcut: "Enter" }));
  items.push(
    item("View Definition", "view", {
      shortcut: object.kind === "materialized_view" ? undefined : "Enter",
    }),
    item(`Edit ${one}…`, "edit", { shortcut: tableShortcutLabel("design") }),
  );
  if (object.kind === "function" || object.kind === "procedure")
    items.push(
      item("Execute…", "execute", {
        disabled: !executable(object, driver),
        title:
          object.flag === "trigger"
            ? "Trigger functions run from triggers and cannot be called directly"
            : driver !== "postgres"
              ? "Open a query tab and CALL or SELECT the routine"
              : undefined,
      }),
    );
  if (object.kind === "event")
    items.push(
      object.status === "ENABLED"
        ? item("Disable Event", "disable")
        : item("Enable Event", "enable"),
    );
  if (object.kind === "sequence") items.push(item("Reset Sequence…", "reset"));
  if (object.kind === "materialized_view")
    items.push(
      item("Refresh Data…", "refresh"),
      item("Refresh Concurrently…", "refresh-concurrently", {
        disabled: !object.refresh_concurrently,
        title: object.refresh_concurrently
          ? "Readers keep seeing the old rows while it refreshes"
          : "Needs a populated view with a unique index on plain columns",
      }),
    );
  items.push(
    item(`New ${one}…`, "new", {
      separatorBefore: true,
      shortcut: tableShortcutLabel("new"),
    }),
    item("Copy Name", "copy-name", { shortcut: tableShortcutLabel("copy") }),
    item(`Drop ${one}…`, "drop", { separatorBefore: true, shortcut: "Delete" }),
  );
  return items;
}
