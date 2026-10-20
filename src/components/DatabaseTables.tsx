import {
  TOOL_GROUPS,
  TOOL_ICONS,
  type DatabaseToolPane,
} from "./databaseToolItems";
import AreaContextMenu, { type AreaMenu } from "./AreaContextMenu";
import { useEffect, useRef, useState } from "react";
import {
  Copy,
  ClipboardPaste,
  Loader2,
  Plus,
  RefreshCw,
  Search,
  Table2,
} from "lucide-react";
import type { SchemaTree, Session, TableInfo } from "../types";
import { useWorkspace } from "../store";
import { tableKey } from "../lib/table-clipboard";
import {
  isMacPlatform,
  tableShortcut,
  tableShortcutLabel,
} from "../lib/table-shortcuts";
import TableContextMenu, {
  type TableAction,
  type TableMenuTarget,
} from "./TableContextMenu";
import { repairableEngine, type MaintainOperation } from "../lib/maintain";

export function formatDataLength(bytes: number | null | undefined): string {
  if (bytes == null || !Number.isFinite(bytes) || bytes < 0) return "—";
  if (bytes < 1024) return `${bytes} B`;
  const units = ["KB", "MB", "GB", "TB", "PB"];
  const exponent = Math.min(
    Math.floor(Math.log(bytes) / Math.log(1024)),
    units.length,
  );
  return `${(bytes / 1024 ** exponent).toLocaleString("en-US", { maximumFractionDigits: 2 })} ${units[exponent - 1]}`;
}

export default function DatabaseTables({
  session,
  database,
  loadSchema,
  onOpen,
  onCreate,
  onAction,
  onCopy,
  onPaste,
  onQuery,
  onMaintain,
  onTool,
  canPaste = false,
}: {
  session: Session;
  database: string;
  loadSchema: (id: string, database: string) => Promise<SchemaTree>;
  onOpen: (table: TableInfo) => void;
  onCreate: () => void;
  onAction: (table: TableInfo, action: TableAction) => void;
  onCopy?: (tables: TableInfo[]) => void;
  onPaste?: (text?: string) => void;
  canPaste?: boolean;
  onTool?: (pane: DatabaseToolPane) => void;
  onQuery?: () => void;
  /** Maintain the right-clicked table, or every selected table when it is selected. */
  onMaintain?: (tables: TableInfo[], operation: MaintainOperation) => void;
}) {
  const [areaMenu, setAreaMenu] = useState<AreaMenu | null>(null);
  const [search, setSearch] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<{
    table: TableInfo;
    target: TableMenuTarget;
  } | null>(null);
  const request = useRef(0);
  const list = useRef<HTMLDivElement>(null);
  const searchInput = useRef<HTMLInputElement>(null);
  const [selected, setSelected] = useState<string[]>([]);
  const [activeKey, setActiveKey] = useState("");
  const anchor = useRef("");
  const [hint, setHint] = useState("");
  const command = /Mac|iPhone|iPad/.test(navigator.platform) ? "⌘" : "Ctrl+";
  const tree = session.trees?.[database];
  async function load() {
    const version = ++request.current;
    setLoading(true);
    setError("");
    try {
      const next = await loadSchema(session.id, database);
      if (version !== request.current) return;
      const state = useWorkspace.getState();
      const current = state.sessions.find((s) => s.id === session.id);
      if (current)
        state.updateSession(session.id, {
          trees: { ...current.trees, [database]: next },
        });
    } catch (cause) {
      if (version === request.current) setError(String(cause));
    } finally {
      if (version === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    if (!tree) void load();
    else setLoading(false);
    return () => {
      request.current++;
    };
    // Cached metadata is shared with the sidebar; invalidation reloads this view.
  }, [session.id, database, session.explorerVersion, !!tree]);

  const term = search.trim().toLowerCase();
  const tables = (tree?.tables ?? []).filter(
    (table) =>
      !term ||
      table.name.toLowerCase().includes(term) ||
      table.schema.toLowerCase().includes(term),
  );
  const selectedTables = tables.filter((table) =>
    selected.includes(tableKey(table)),
  );
  const active =
    tables.find((table) => tableKey(table) === activeKey) ?? tables[0];
  useEffect(() => {
    const keys = new Set(tables.map(tableKey));
    setSelected((old) => old.filter((key) => keys.has(key)));
    setActiveKey((old) =>
      keys.has(old) ? old : tables[0] ? tableKey(tables[0]) : "",
    );
  }, [tree, term]);
  function choose(table: TableInfo, extend = false, toggle = false) {
    const key = tableKey(table);
    if (extend) {
      const first = Math.max(
        0,
        tables.findIndex((row) => tableKey(row) === anchor.current),
      );
      const last = tables.findIndex((row) => tableKey(row) === key);
      setSelected(
        tables
          .slice(Math.min(first, last), Math.max(first, last) + 1)
          .map(tableKey),
      );
    } else if (toggle) {
      setSelected((old) =>
        old.includes(key) ? old.filter((item) => item !== key) : [...old, key],
      );
      anchor.current = key;
    } else {
      setSelected([key]);
      anchor.current = key;
    }
    setActiveKey(key);
  }
  function focusTable(table: TableInfo) {
    const button = [
      ...(list.current?.querySelectorAll<HTMLButtonElement>(
        ".database-table-open",
      ) ?? []),
    ].find((node) => node.dataset.tableKey === tableKey(table));
    button?.focus({ preventScroll: true });
    button?.closest("tr")?.scrollIntoView?.({ block: "nearest" });
  }
  function copySelection() {
    if (!selectedTables.length) return;
    onCopy?.(selectedTables);
  }
  const metadata = new Map(
    (tree?.table_metadata ?? []).map((item) => [
      JSON.stringify([item.schema, item.name]),
      item,
    ]),
  );
  const maintainTargets = (
    menu && selected.includes(tableKey(menu.table))
      ? selectedTables
      : menu
        ? [menu.table]
        : []
  ).filter((table) => table.kind === "table");
  return (
    <section
      className="database-tables"
      aria-label={`Tables in ${database}`}
      aria-busy={loading}
      onContextMenu={(event) => {
        if (event.defaultPrevented) {
          setAreaMenu(null);
          return;
        }
        if (
          (event.target as HTMLElement).closest(
            "input, textarea, select, [role='menu']",
          )
        )
          return;
        event.preventDefault();
        event.stopPropagation();
        setMenu(null);
        setAreaMenu({
          x: event.clientX,
          y: event.clientY,
          trigger: list.current!,
          label: "Table list actions",
          items: [
            { label: "New Table…", action: onCreate },
            {
              label: "New Query",
              action: () => onQuery?.(),
              disabled: !onQuery,
            },
            {
              label: "Paste tables…",
              action: () => onPaste?.(),
              disabled: !canPaste || !onPaste,
            },
            { label: "Refresh", action: () => void load(), disabled: loading },
          ],
        });
      }}
      onPaste={(event) => {
        if ((event.target as HTMLElement).closest("input, textarea, select"))
          return;
        event.preventDefault();
        event.stopPropagation();
        onPaste?.(event.clipboardData.getData("text/plain"));
      }}
      onKeyDown={(event) => {
        const editingText = (event.target as HTMLElement).closest(
          "input, textarea, select, [contenteditable='true']",
        );
        const action = tableShortcut(event);
        if (editingText) {
          if (action === "refresh" || action === "find") {
            event.preventDefault();
            event.stopPropagation();
            if (action === "refresh" && !loading) void load();
            if (action === "find") searchInput.current?.focus();
          }
          return;
        }
        if (menu) return;
        const cmd = isMacPlatform()
          ? event.metaKey && !event.ctrlKey
          : event.ctrlKey && !event.metaKey;
        if (action) {
          event.preventDefault();
          event.stopPropagation();
          if (action === "all") setSelected(tables.map(tableKey));
          if (action === "copy") copySelection();
          if (action === "paste") onPaste?.();
          if (action === "find") searchInput.current?.focus();
          if (action === "refresh" && !loading) void load();
          if (action === "new") onCreate();
          if (action === "design" && active) onAction(active, "structure");
          if (action === "duplicate" && active?.kind === "table")
            onAction(active, "copy");
          if (action === "query") onQuery?.();
          if (action === "transfer" && active?.kind === "table")
            onAction(active, "transfer");
          return;
        }
        // Modified navigation belongs to OS/app commands, not list movement.
        if (event.metaKey || event.ctrlKey || event.altKey) {
          if (!(
            cmd &&
            !event.altKey &&
            !event.shiftKey &&
            event.key === "Backspace"
          ))
            return;
        }
        if (
          ["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) &&
          tables.length
        ) {
          event.preventDefault();
          event.stopPropagation();
          const index = Math.max(
            0,
            tables.findIndex((table) => tableKey(table) === tableKey(active)),
          );
          const next =
            event.key === "Home"
              ? 0
              : event.key === "End"
                ? tables.length - 1
                : Math.max(
                    0,
                    Math.min(
                      tables.length - 1,
                      index + (event.key === "ArrowDown" ? 1 : -1),
                    ),
                  );
          choose(tables[next], event.shiftKey);
          focusTable(tables[next]);
        } else if (
          event.key === "Enter" &&
          active &&
          ((event.target as HTMLElement).closest(".database-table-open") ||
            event.target === list.current)
        ) {
          event.preventDefault();
          event.stopPropagation();
          onOpen(active);
        } else if (
          (event.key === "Delete" || (cmd && event.key === "Backspace")) &&
          active
        ) {
          event.preventDefault();
          event.stopPropagation();
          if (selectedTables.length > 1)
            setHint(
              "Delete one table at a time using its permanent-delete confirmation.",
            );
          else if (selectedTables[0]) onAction(selectedTables[0], "drop");
        } else if (event.key === "F2" && active) {
          // F2 renames, as in Navicat and file managers; one table at a time.
          event.preventDefault();
          event.stopPropagation();
          if (selectedTables.length > 1) setHint("Rename one table at a time.");
          else onAction(selectedTables[0] ?? active, "rename");
        } else if (event.key === "Escape") {
          setSelected([]);
          setHint("");
        }
      }}
    >
      <div className="database-tables-toolbar">
        <div className="database-tables-title">
          <Table2 size={16} />
          <strong>Tables</strong>
          <span>{tree?.tables.length ?? "—"}</span>
        </div>
        <div
          className="toolbar-group"
          role="group"
          aria-label="Table management"
        >
          <button
            className="button secondary"
            title={`${tableShortcutLabel("new")} · New Table`}
            onClick={onCreate}
          >
            <Plus size={14} />
            New Table
          </button>
          <button
            className="icon-button"
            aria-label="Refresh database tables"
            title={`${tableShortcutLabel("refresh")} · Refresh tables`}
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw size={15} className={loading ? "spin" : ""} />
          </button>
        </div>
        <div
          className="toolbar-group"
          role="group"
          aria-label="Table clipboard"
        >
          <button
            className="icon-button"
            aria-label="Copy selected tables"
            title={`${command}C · Copy selected tables`}
            disabled={!selectedTables.length || !onCopy}
            onClick={copySelection}
          >
            <Copy size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="Paste tables into this database"
            title={`${command}V · Paste tables`}
            disabled={!canPaste}
            onClick={() => onPaste?.()}
          >
            <ClipboardPaste size={15} />
          </button>
        </div>
        {onTool &&
          TOOL_GROUPS.map((group) => (
            <div
              className="toolbar-group database-list-tools"
              role="group"
              aria-label={group.label}
              key={group.label}
            >
              {group.panes.map((pane) => {
                const Icon = TOOL_ICONS[pane];
                return (
                  <button
                    className="button secondary"
                    key={pane}
                    aria-label={pane}
                    title={pane}
                    onClick={() => onTool(pane)}
                  >
                    <Icon size={14} aria-hidden="true" />
                    <span className="database-list-tool-label">{pane}</span>
                  </button>
                );
              })}
            </div>
          ))}
        <div className="spacer" />
        <label className="search">
          <Search size={14} />
          <input
            ref={searchInput}
            aria-label="Search tables in database"
            placeholder="Find table or schema…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
        </label>
      </div>
      {areaMenu && (
        <AreaContextMenu menu={areaMenu} onClose={() => setAreaMenu(null)} />
      )}
      {error && (
        <div className="database-tables-error" role="alert">
          {error}
          <button className="button secondary" onClick={() => void load()}>
            Retry
          </button>
        </div>
      )}
      {loading && !tree ? (
        <div className="empty">
          <Loader2 size={24} className="spin" />
          <p>Loading tables…</p>
        </div>
      ) : (
        <div
          ref={list}
          className="database-tables-scroll"
          tabIndex={tables.length ? -1 : 0}
          onClick={(event) => {
            if (event.target === event.currentTarget)
              event.currentTarget.focus();
          }}
        >
          <table aria-label={`Table list for ${database}`}>
            <thead>
              <tr>
                <th scope="col">Name</th>
                <th
                  scope="col"
                  className="numeric"
                  title="Row statistics reported by the database; may be estimated"
                >
                  Rows
                </th>
                <th scope="col" className="numeric">
                  Data Length
                </th>
                <th scope="col">Engine</th>
                <th scope="col">Created Date</th>
                <th scope="col">Modified Date</th>
                <th scope="col">Collation</th>
                <th scope="col">Comment</th>
              </tr>
            </thead>
            <tbody>
              {tables.map((table) => {
                const detail = metadata.get(
                  JSON.stringify([table.schema, table.name]),
                );
                return (
                  <tr
                    key={JSON.stringify([table.schema, table.name])}
                    aria-selected={selected.includes(tableKey(table))}
                    className={
                      [
                        selected.includes(tableKey(table)) ? "selected" : "",
                        menu?.table.name === table.name &&
                        menu.table.schema === table.schema
                          ? "context-selected"
                          : "",
                      ]
                        .filter(Boolean)
                        .join(" ") || undefined
                    }
                    onClick={(event) =>
                      choose(
                        table,
                        event.shiftKey,
                        event.metaKey || event.ctrlKey,
                      )
                    }
                    onContextMenu={(event) => {
                      event.preventDefault();
                      if (!selected.includes(tableKey(table))) choose(table);
                      const trigger =
                        event.currentTarget.querySelector<HTMLElement>(
                          ".database-table-open",
                        )!;
                      const rect = trigger.getBoundingClientRect();
                      setMenu({
                        table,
                        target: {
                          x: event.clientX || rect.left + 16,
                          y: event.clientY || rect.bottom,
                          trigger,
                        },
                      });
                    }}
                    onKeyDown={(event) => {
                      if (
                        event.key !== "ContextMenu" &&
                        !(event.shiftKey && event.key === "F10")
                      )
                        return;
                      event.preventDefault();
                      const trigger =
                        event.currentTarget.querySelector<HTMLElement>(
                          ".database-table-open",
                        )!;
                      const rect = trigger.getBoundingClientRect();
                      setMenu({
                        table,
                        target: { x: rect.left + 16, y: rect.bottom, trigger },
                      });
                    }}
                    onDoubleClick={() => {
                      choose(table);
                      onOpen(table);
                    }}
                  >
                    <td>
                      <button
                        className="database-table-open"
                        aria-label={table.name}
                        data-table-key={tableKey(table)}
                        tabIndex={
                          active && tableKey(active) === tableKey(table)
                            ? 0
                            : -1
                        }
                        onFocus={() => setActiveKey(tableKey(table))}
                        title={`Select ${table.name}; double-click or Enter to open`}
                      >
                        <Table2 size={15} />
                        <span>
                          {table.name}
                          {session.config.driver === "postgres" &&
                            table.schema && (
                              <small className="database-table-schema">
                                {table.schema}
                              </small>
                            )}
                        </span>
                        {table.kind === "view" && (
                          <span className="database-table-kind">View</span>
                        )}
                      </button>
                    </td>
                    <td
                      className="numeric"
                      title="Row statistics reported by the database; may be estimated"
                    >
                      {detail?.rows == null
                        ? "—"
                        : detail.rows.toLocaleString("en-US")}
                    </td>
                    <td
                      className="numeric"
                      title={
                        detail?.data_length == null
                          ? undefined
                          : `${detail.data_length.toLocaleString("en-US")} bytes`
                      }
                    >
                      {formatDataLength(detail?.data_length)}
                    </td>
                    <td>{detail?.engine || "—"}</td>
                    <td className="date">{detail?.created_date || "—"}</td>
                    <td className="date">{detail?.modified_date || "—"}</td>
                    <td>{detail?.collation || "—"}</td>
                    <td className="database-table-comment">
                      {detail?.comment || "—"}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {!tables.length && !error && (
            <div className="empty">
              <Table2 size={26} />
              <h3>{term ? "No matching tables" : "No tables yet"}</h3>
              <p>
                {term
                  ? "Try another table name or schema."
                  : "Create a table to start adding data."}
              </p>
            </div>
          )}
        </div>
      )}
      {menu && (
        <TableContextMenu
          table={menu.table}
          target={menu.target}
          onClose={() => setMenu(null)}
          onAction={(action) => onAction(menu.table, action)}
          clipboardActions={
            onCopy && onPaste
              ? { copy: copySelection, paste: () => onPaste(), canPaste }
              : undefined
          }
          maintain={
            onMaintain
              ? {
                  driver: session.config.driver,
                  count: maintainTargets.length,
                  repairable: maintainTargets.every((table) =>
                    repairableEngine(
                      metadata.get(JSON.stringify([table.schema, table.name]))
                        ?.engine,
                    ),
                  ),
                  onMaintain: (operation) =>
                    onMaintain(maintainTargets, operation),
                }
              : undefined
          }
        />
      )}
      <div className="database-tables-footer">
        {tables.length} of {tree?.tables.length ?? 0} tables and views
        <span>
          {hint ||
            `${selectedTables.length} selected · ↑↓ Select · Enter Open · ${command}C Copy · ${command}V Paste`}
        </span>
      </div>
    </section>
  );
}
