import DatabaseObjectError from "./DatabaseObjectError";
import { useEffect, useRef, useState } from "react";
import { Loader2, Plus, RefreshCw, Search } from "lucide-react";
import type { DbObject, ObjectKind, Session } from "../types";
import {
  OBJECT_LABELS,
  matchesObject,
  objectKey,
  objectLabel,
} from "../lib/db-objects";
import { tableShortcutLabel } from "../lib/table-shortcuts";
import { useDbObjects } from "../hooks/useDbObjects";
import AreaContextMenu, { type AreaMenu } from "./AreaContextMenu";
import { ObjectIcon } from "./ExplorerObjects";
import {
  defaultObjectAction,
  objectMenuItems,
  objectShortcut,
  type ObjectAction,
} from "./objectMenu";

type Column = { label: string; value: (object: DbObject) => string };
function columns(kind: ObjectKind, postgres: boolean): Column[] {
  const schema: Column[] = postgres
    ? [{ label: "Schema", value: (o) => o.schema }]
    : [];
  const comment: Column = { label: "Comment", value: (o) => o.comment ?? "" };
  switch (kind) {
    case "function":
    case "procedure":
      return [
        ...schema,
        ...(postgres
          ? [{ label: "Arguments", value: (o: DbObject) => o.signature ?? "" }]
          : []),
        {
          label: postgres ? "Returns · Language" : "Returns · Definer",
          value: (o) => o.detail ?? "",
        },
        ...(postgres
          ? []
          : [{ label: "Modified", value: (o: DbObject) => o.status ?? "" }]),
        comment,
      ];
    case "trigger":
      return [
        ...schema,
        { label: "Table", value: (o) => o.table ?? "" },
        { label: "Timing", value: (o) => o.detail ?? "" },
        ...(postgres
          ? [{ label: "Status", value: (o: DbObject) => o.status ?? "" }]
          : []),
      ];
    case "event":
      return [
        { label: "Status", value: (o) => o.status ?? "" },
        { label: "Schedule", value: (o) => o.detail ?? "" },
        comment,
      ];
    case "sequence":
      return [
        ...schema,
        { label: "Type", value: (o) => o.detail ?? "" },
        { label: "Current Value", value: (o) => o.last_value ?? "not used" },
        { label: "Increment", value: (o) => o.increment ?? "" },
        { label: "Start", value: (o) => o.start ?? "" },
        comment,
      ];
    case "materialized_view":
      return [
        ...schema,
        { label: "Status", value: (o) => o.status ?? "" },
        { label: "Size", value: (o) => o.detail ?? "" },
        comment,
      ];
  }
}

/** Navicat-style list of one object kind in a database, with search, keys and menus. */
export function DatabaseObjects({
  session,
  database,
  kind,
  onAction,
  onNew,
}: {
  session: Session;
  database: string;
  kind: ObjectKind;
  onAction: (object: DbObject, action: ObjectAction) => void;
  onNew: () => void;
}) {
  const { objects, loading, error, reload } = useDbObjects(
    session,
    database,
    kind,
    true,
  );
  const [search, setSearch] = useState("");
  const [activeKey, setActiveKey] = useState("");
  const [menu, setMenu] = useState<AreaMenu | null>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const list = useRef<HTMLDivElement>(null);
  const label = OBJECT_LABELS[kind];
  const term = search.trim().toLowerCase();
  const visible = (objects ?? []).filter((object) =>
    matchesObject(object, term),
  );
  const active =
    visible.find((object) => objectKey(object) === activeKey) ?? visible[0];
  useEffect(() => setActiveKey(""), [kind]);
  const cols = columns(kind, session.config.driver === "postgres");
  function focusObject(object: DbObject) {
    const button = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>(
        ".database-table-open",
      ) ?? []),
    ].find((node) => node.dataset.objectKey === objectKey(object));
    button?.focus({ preventScroll: true });
    button?.closest("tr")?.scrollIntoView?.({ block: "nearest" });
  }
  function showMenu(
    object: DbObject,
    trigger: HTMLElement,
    x?: number,
    y?: number,
  ) {
    const rect = trigger.getBoundingClientRect();
    setActiveKey(objectKey(object));
    setMenu({
      x: x ?? rect.left + 16,
      y: y ?? rect.bottom,
      trigger,
      label: `${objectLabel(object)} actions`,
      items: objectMenuItems(object, session.config.driver, (action) =>
        onAction(object, action),
      ),
    });
  }
  return (
    <section
      className="database-tables database-objects"
      aria-label={`${label.many} in ${database}`}
      aria-busy={loading}
      onKeyDown={(event) => {
        if (menu) return;
        const editing = (event.target as HTMLElement).closest(
          "input, textarea, select",
        );
        const shortcut = objectShortcut(event);
        if (shortcut === "find" || shortcut === "refresh") {
          event.preventDefault();
          event.stopPropagation();
          if (shortcut === "find") searchInput.current?.focus();
          else if (!loading) void reload();
          return;
        }
        if (editing) return;
        if (shortcut === "new") {
          event.preventDefault();
          onNew();
          return;
        }
        if (shortcut && active) {
          event.preventDefault();
          onAction(active, shortcut);
          return;
        }
        if (event.metaKey || event.ctrlKey || event.altKey) {
          if (!((event.metaKey || event.ctrlKey) && event.key === "Backspace"))
            return;
        }
        if (
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
          visible.length
        ) {
          event.preventDefault();
          const index = Math.max(0, active ? visible.indexOf(active) : 0);
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? visible.length - 1
                : Math.max(
                    0,
                    Math.min(
                      visible.length - 1,
                      index + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  );
          setActiveKey(objectKey(visible[next]));
          focusObject(visible[next]);
        } else if (event.key === "Enter" && active) {
          event.preventDefault();
          onAction(active, defaultObjectAction(active));
        } else if (
          (event.key === "Delete" || event.key === "Backspace") &&
          active &&
          (event.key === "Delete" || event.metaKey || event.ctrlKey)
        ) {
          event.preventDefault();
          onAction(active, "drop");
        }
      }}
    >
      <div className="database-tables-toolbar">
        <div className="database-tables-title">
          <ObjectIcon kind={kind} size={16} />
          <strong>{label.many}</strong>
          <span>{objects?.length ?? "—"}</span>
        </div>
        <label className="search">
          <Search size={14} />
          <input
            ref={searchInput}
            aria-label={`Search ${label.many.toLowerCase()} in database`}
            placeholder={`Find ${label.one.toLowerCase()}…`}
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
        <button
          className="button secondary"
          title={`${tableShortcutLabel("new")} · New ${label.one}`}
          onClick={onNew}
        >
          <Plus size={14} />
          New {label.one}
        </button>
        <button
          className="icon-button"
          aria-label={`Refresh ${label.many.toLowerCase()}`}
          title={`${tableShortcutLabel("refresh")} · Refresh`}
          disabled={loading}
          onClick={() => void reload()}
        >
          <RefreshCw size={15} className={loading ? "spin" : ""} />
        </button>
      </div>
      {error && (
        <DatabaseObjectError error={error} onRetry={() => void reload()} />
      )}
      {loading && !objects ? (
        <div className="empty">
          <Loader2 size={24} className="spin" />
          <p>Loading {label.many.toLowerCase()}…</p>
        </div>
      ) : (
        <div ref={list} className="database-tables-scroll">
          <table aria-label={`${label.one} list for ${database}`}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                {cols.map((column) => (
                  <th scope="col" key={column.label}>
                    {column.label}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {visible.map((object) => {
                const key = objectKey(object);
                return (
                  <tr
                    key={key}
                    aria-selected={active === object}
                    className={active === object ? "selected" : undefined}
                    onClick={() => setActiveKey(key)}
                    onDoubleClick={() =>
                      onAction(object, defaultObjectAction(object))
                    }
                    onContextMenu={(event) => {
                      event.preventDefault();
                      showMenu(
                        object,
                        event.currentTarget.querySelector<HTMLElement>(
                          ".database-table-open",
                        )!,
                        event.clientX,
                        event.clientY,
                      );
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key !== "ContextMenu" &&
                        !(event.shiftKey && event.key === "F10")
                      )
                        return;
                      event.preventDefault();
                      event.stopPropagation();
                      showMenu(
                        object,
                        event.currentTarget.querySelector<HTMLElement>(
                          ".database-table-open",
                        )!,
                      );
                    }}
                  >
                    <td>
                      <button
                        className="database-table-open"
                        aria-label={objectLabel(object)}
                        data-object-key={key}
                        tabIndex={active === object ? 0 : -1}
                        onFocus={() => setActiveKey(key)}
                        title={`Select ${objectLabel(object)}; double-click or Enter to ${defaultObjectAction(object) === "open-data" ? "open its data" : "view its definition"}`}
                      >
                        <ObjectIcon kind={kind} size={15} />
                        <span>{objectLabel(object)}</span>
                        {object.flag === "trigger" && (
                          <span className="database-table-kind">Trigger</span>
                        )}
                        {object.status === "DISABLED" && (
                          <span className="database-table-kind">Disabled</span>
                        )}
                      </button>
                    </td>
                    {cols.map((column) => (
                      <td key={column.label} className="database-table-comment">
                        {column.value(object) || "—"}
                      </td>
                    ))}
                  </tr>
                );
              })}
            </tbody>
          </table>
          {objects && !visible.length && !error && (
            <div className="empty">
              <ObjectIcon kind={kind} size={26} />
              <h3>
                {term
                  ? `No matching ${label.many.toLowerCase()}`
                  : `No ${label.many.toLowerCase()} yet`}
              </h3>
              <p>
                {term
                  ? "Try another name, schema or table."
                  : `Use New ${label.one} to start from a template.`}
              </p>
            </div>
          )}
        </div>
      )}
      {menu && <AreaContextMenu menu={menu} onClose={() => setMenu(null)} />}
      <div className="database-tables-footer">
        {visible.length} of {objects?.length ?? 0} {label.many.toLowerCase()}
        <span>
          ↑↓ Select · Enter{" "}
          {kind === "materialized_view" ? "Open" : "Definition"} ·{" "}
          {tableShortcutLabel("design")} Edit · Delete Drop
        </span>
      </div>
    </section>
  );
}
