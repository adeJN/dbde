import type { DatabaseToolPane } from "./components/databaseToolItems";
import DatabaseTools from "./components/DatabaseTools";
import AreaContextMenu, { type AreaMenu } from "./components/AreaContextMenu";
import { textContextItems } from "./lib/text-context-menu";
import HelpDialog from "./components/HelpDialog";
import ThemeToggle from "./components/ThemeToggle";
import AppUpdater from "./components/AppUpdater";
import {
  editorSearchFromKey,
  editorSearchShortcut,
  openEditorSearch,
} from "./lib/editor-search";
import PasteTablesDialog from "./components/PasteTablesDialog";
import type { TableClipboard } from "./lib/table-clipboard";
import { writeClipboard } from "./lib/clipboard";
import { useAutoDismiss } from "./hooks/useAutoDismiss";
import { createPortal } from "react-dom";
import {
  lazy,
  Suspense,
  useCallback,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import {
  Database,
  Plus,
  ChevronDown,
  ChevronRight,
  Search,
  Replace,
  Table2,
  FileCode2,
  X,
  Play,
  Wand2,
  RefreshCw,
  Unplug,
  CircleHelp,
  Terminal,
  Layers,
  ArrowUpRight,
  Loader2,
  Columns3,
  Trash2,
  PanelLeftClose,
  PanelLeftOpen,
  Maximize2,
  Minimize2,
  Code2,
  MoreHorizontal,
  KeyRound,
  Square,
  Eraser,
  Download,
  Copy,
  Pin,
  Star,
  FolderClosed,
  History,
  Save,
  Braces,
  BookMarked,
  ListTree,
} from "lucide-react";
import type * as Monaco from "monaco-editor";
import { useWorkspace } from "./store";
import * as api from "./lib/api";
import type {
  ColumnInfo,
  IndexInfo,
  ConnectionConfig,
  Session,
  TableInfo,
  TableFilter,
  TableSort,
  QueryTab,
  TableSource,
  TableShortcut,
  ForeignKeyChecks,
  QueryResult,
  DbObject,
  ObjectKind,
  ObjectStatementAction,
} from "./types";
import { destructiveStatements, tableActionSql, tableQuery } from "./lib/sql";
import { rowKeys } from "./lib/rows";
import { pendingCount } from "./lib/staged";
import ResultGrid from "./components/ResultGrid";
import ResizableSidebar from "./components/ResizableSidebar";
import DatabaseTables from "./components/DatabaseTables";
import TableContextMenu, {
  type TableAction,
  type TableMenuTarget,
} from "./components/TableContextMenu";
import TabContextMenu, {
  type TabAction,
  type TabMenuTarget,
} from "./components/TabContextMenu";
import useTabDrag from "./components/useTabDrag";
import { useQueryLibrary } from "./hooks/useQueryLibrary";
import HistoryPanel from "./components/HistoryPanel";
import SavedQueriesPanel from "./components/SavedQueriesPanel";
import SaveQueryDialog from "./components/SaveQueryDialog";
import UnsavedQueryDialog, {
  type UnsavedChoice,
} from "./components/UnsavedQueryDialog";
import SnippetsPanel from "./components/SnippetsPanel";
import ExplorerQueries from "./components/ExplorerQueries";
import ExplorerObjects from "./components/ExplorerObjects";
import SequenceResetDialog from "./components/SequenceResetDialog";
import type { ObjectAction } from "./components/objectMenu";
import {
  OBJECT_LABELS,
  newObjectTemplate,
  objectLabel,
  objectSqlName,
} from "./lib/db-objects";
import ChooseConnectionDialog from "./components/ChooseConnectionDialog";
import { historyEntry, type HistoryEntry } from "./lib/query-history";
import {
  duplicateSavedQuery,
  savedQueryNameError,
  tabHasUnsavedQuery,
  uniqueQueryName,
  type SavedQuery,
} from "./lib/saved-queries";
import { expandSnippet, snippetsFor, type Snippet } from "./lib/snippets";
import { appendSql, insertIntoEditor } from "./lib/editor-insert";
import {
  libraryShortcutFromKey,
  libraryShortcutLabel,
} from "./lib/library-shortcuts";
import {
  favoriteFor,
  readTabFavorites,
  tabsToClose,
  type TabFavorite,
} from "./lib/tab-actions";
import ConnectionDialog from "./components/ConnectionDialog";
import ConnectionContextMenu, {
  type ConnectionAction,
  type ConnectionMenuTarget,
} from "./components/ConnectionContextMenu";
import ConnectionActionDialog from "./components/ConnectionActionDialog";
import {
  duplicateConnection,
  flushCommands,
  readConnectionAppearance,
  type ConnectionAppearance,
} from "./lib/connection-menu";
import appIcon from "../app-icon.svg";
import TableDesigner, {
  type TableDesignerRequest,
} from "./components/TableDesigner";
import TableStructure, {
  type TableStructureRequest,
} from "./components/TableStructure";
import ConfirmDialog, { type ConfirmRequest } from "./components/ConfirmDialog";
import DdlDialog from "./components/DdlDialog";
import PlanView from "./components/PlanView";
import MaintainResultDialog from "./components/MaintainResultDialog";
import { explainSql, explainTarget, isReadOnlyStatement } from "./lib/explain";
import {
  maintainInfo,
  maintainSql,
  repairableEngine,
  type MaintainOperation,
  type MaintainResult,
} from "./lib/maintain";
import RenameTableDialog from "./components/RenameTableDialog";
import ExportDialog, { type ExportRequest } from "./components/ExportDialog";
import { exportSummaryText } from "./lib/export";
import ImportDialog from "./components/ImportDialog";
import { importSummaryText, type ImportSummary } from "./lib/import";
import TableToolsDialog, {
  type TableToolRequest,
} from "./components/TableToolsDialog";
import { dumpTable } from "./lib/table-tools";
import {
  connectionKey,
  withoutSecrets,
  configuredDatabases,
} from "./lib/connections";
import {
  createExplorerLoader,
  matchingTables,
  searchTerm,
} from "./lib/explorer-search";
const explorerSchema = createExplorerLoader((id, database) =>
  api.schema(id, database),
);
import DatabaseDialog, {
  type DatabaseRequest,
} from "./components/DatabaseDialog";
import DatabaseUtilityDialog, {
  type DatabaseUtilityRequest,
} from "./components/DatabaseUtilityDialog";
import { databaseFileName, dumpDatabase } from "./lib/database-tools";
const QueryEditor = lazy(() => import("./components/QueryEditor"));
type DatabaseAction =
  | "new-table"
  | "close"
  | "edit"
  | "new"
  | "delete"
  | "execute-file"
  | "dump-structure"
  | "dump-data"
  | "find"
  | "share";
const QUERY_TIMEOUTS: [number, string][] = [
  [30, "30 s"],
  [120, "2 min"],
  [600, "10 min"],
  [3600, "1 hour"],
];
function ExplorerTable({
  session,
  table,
  database,
  onOpen,
  onAction,
  onMaintain,
}: {
  session: Session;
  table: TableInfo;
  database: string;
  onOpen: () => void;
  onAction: (action: TableAction) => void;
  onMaintain?: (operation: MaintainOperation) => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [cols, setCols] = useState<ColumnInfo[]>();
  const [indexes, setIndexes] = useState<IndexInfo[]>([]);
  const [error, setError] = useState("");
  const [menu, setMenu] = useState<TableMenuTarget | null>(null);
  async function toggle() {
    setExpanded(!expanded);
    if (!expanded && !cols)
      try {
        const [columns, found] = await Promise.all([
          api.columns(session.id, table, database),
          // Index metadata is a bonus; a failure here must not hide the columns.
          api.listIndexes(session.id, table, database).catch(() => []),
        ]);
        setCols(columns);
        setIndexes(found);
      } catch (e) {
        setError(String(e));
      }
  }
  function act(action: TableAction) {
    setMenu(null);
    onAction(action);
  }
  return (
    <>
      <div
        className="table-node"
        data-table-name={table.name}
        data-table-schema={table.schema}
        onKeyDown={(event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "d" &&
            !event.shiftKey &&
            !event.altKey
          ) {
            event.preventDefault();
            event.stopPropagation();
            act("structure");
          }
        }}
        onContextMenu={(e) => {
          e.preventDefault();
          setMenu({
            trigger: e.currentTarget.querySelector<HTMLElement>(".table-name")!,
            x: Math.min(e.clientX, window.innerWidth - 230),
            y: Math.min(
              e.clientY,
              Math.min(430, window.innerHeight * 0.85) - 8,
            ),
          });
        }}
      >
        <button
          className="tiny-button"
          aria-label={`Expand ${table.name} columns`}
          onClick={() => void toggle()}
        >
          {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <button
          className="table-name"
          onClick={onOpen}
          title={`View ${table.schema ? table.schema + "." : ""}${table.name}`}
        >
          <Table2 size={14} />
          <span>{table.name}</span>
          <span className="node-kind">
            {table.kind === "view" ? "view" : ""}
          </span>
        </button>
        <button
          className="tiny-button table-actions"
          aria-label={`Actions for ${table.name}`}
          aria-haspopup="menu"
          onClick={(e) => {
            const box = e.currentTarget.getBoundingClientRect();
            setMenu({
              trigger: e.currentTarget,
              x: Math.min(box.left, window.innerWidth - 230),
              y: Math.min(
                box.bottom + 4,
                Math.min(430, window.innerHeight * 0.85) - 8,
              ),
            });
          }}
        >
          <MoreHorizontal size={12} />
        </button>
      </div>
      {menu && (
        <TableContextMenu
          table={table}
          target={menu}
          onClose={() => setMenu(null)}
          onAction={act}
          maintain={
            onMaintain
              ? {
                  driver: session.config.driver,
                  count: table.kind === "table" ? 1 : 0,
                  repairable: repairableEngine(
                    session.trees?.[database]?.table_metadata?.find(
                      (item) =>
                        item.name === table.name &&
                        item.schema === table.schema,
                    )?.engine,
                  ),
                  onMaintain: (operation) => {
                    setMenu(null);
                    onMaintain(operation);
                  },
                }
              : undefined
          }
        />
      )}
      {expanded && (
        <div className="column-nodes">
          {error ? (
            <span className="error">{error}</span>
          ) : !cols ? (
            <span>Loading columns…</span>
          ) : (
            <>
              {cols.map((c) => (
                <div
                  key={c.name}
                  title={`${c.data_type}${c.nullable ? " · nullable" : " · not null"}`}
                >
                  <Columns3 size={11} />
                  <span>{c.name}</span>
                  <small>{c.data_type}</small>
                </div>
              ))}
              {indexes.map((index) => (
                <div
                  key={`index:${index.name}`}
                  className="index-node"
                  title={`${index.primary ? "Primary key" : index.unique ? "Unique index" : "Index"} ${index.name} (${index.columns.join(", ")})`}
                >
                  <KeyRound size={11} />
                  <span>{index.name}</span>
                  <small>
                    {index.primary ? "primary" : index.unique ? "unique" : ""}{" "}
                    {index.columns.join(", ")}
                  </small>
                </div>
              ))}
            </>
          )}
        </div>
      )}
    </>
  );
}
function ExplorerDatabase({
  session,
  database,
  search,
  onOpen,
  onQuery,
  onAction,
  onMaintain,
  onDatabaseAction,
  onBrowse,
  reveal,
  children,
}: {
  children?: React.ReactNode;
  session: Session;
  database: string;
  search: string;
  onOpen: (table: TableInfo) => void;
  onQuery: () => void;
  onAction: (table: TableInfo, action: TableAction) => void;
  onMaintain?: (table: TableInfo, operation: MaintainOperation) => void;
  onDatabaseAction: (action: DatabaseAction) => Promise<boolean>;
  onBrowse: () => void;
  reveal?: {
    connectionId: string;
    database: string;
    table?: TableInfo;
    nonce: number;
  };
}) {
  const autoOpen =
    session.config.driver === "sqlite" ||
    (session.config.options?.custom_database_list
      ? !!session.config.options.database_list?.some(
          (entry) => entry.name === database && entry.auto_open,
        )
      : session.config.database === database);
  const [expanded, setExpanded] = useState(autoOpen);
  useEffect(() => setExpanded(autoOpen), [autoOpen]);
  const term = searchTerm(search);
  const [searchCollapsed, setSearchCollapsed] = useState(false);
  const open = term ? !searchCollapsed : expanded;
  useEffect(() => setSearchCollapsed(false), [term]);
  const [menu, setMenu] = useState<{ x: number; y: number } | null>(null);
  const toggleButton = useRef<HTMLButtonElement>(null);
  const branch = useRef<HTMLDivElement>(null);
  useEffect(() => {
    if (reveal?.connectionId !== session.id || reveal.database !== database)
      return;
    setExpanded(true);
    setSearchCollapsed(false);
  }, [reveal, session.id, database]);
  useEffect(() => {
    if (reveal?.connectionId !== session.id || reveal.database !== database)
      return;
    const frame = requestAnimationFrame(() => {
      const rows = Array.from(
        branch.current?.querySelectorAll<HTMLElement>("[data-table-name]") ??
          [],
      );
      const target = reveal.table
        ? rows
            .find(
              (row) =>
                row.dataset.tableName === reveal.table!.name &&
                row.dataset.tableSchema === reveal.table!.schema,
            )
            ?.querySelector<HTMLButtonElement>(".table-name")
        : toggleButton.current;
      target?.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      target?.focus();
    });
    return () => cancelAnimationFrame(frame);
  }, [reveal, session.id, database, session.trees?.[database], expanded]);
  const [dumpOpen, setDumpOpen] = useState(false);
  const [dumpAnchor, setDumpAnchor] = useState({ x: 0, y: 0 });
  const dumpTrigger = useRef<HTMLElement | null>(null);
  const dumpMenu = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!dumpOpen || !dumpTrigger.current || !dumpMenu.current) return;
    const trigger = dumpTrigger.current.getBoundingClientRect();
    const bounds = dumpMenu.current.getBoundingClientRect();
    const width = bounds.width || 224;
    const height = bounds.height || 84;
    const right = trigger.right + 6;
    setDumpAnchor({
      x: Math.max(
        8,
        Math.min(
          right + width <= window.innerWidth - 8
            ? right
            : trigger.left - width - 6,
          window.innerWidth - width - 8,
        ),
      ),
      y: Math.max(8, Math.min(trigger.top, window.innerHeight - height - 8)),
    });
  }, [dumpOpen]);
  function showDump(button: HTMLElement) {
    dumpTrigger.current = button;
    setDumpOpen(true);
  }
  const mac = /mac/i.test(navigator.platform);
  const mod = mac ? "⌘" : "Ctrl+";
  const sqlite = session.config.driver === "sqlite";
  const system =
    session.config.driver === "mysql"
      ? ["mysql", "information_schema", "performance_schema", "sys"].includes(
          database.toLowerCase(),
        )
      : ["postgres", "template0", "template1"].includes(database);
  const closeDatabase = () => {
    void onDatabaseAction("close").then((ok) => {
      if (ok) {
        setExpanded(false);
        setSearchCollapsed(true);
      }
    });
  };
  function shortcut(event: {
    key: string;
    metaKey: boolean;
    ctrlKey: boolean;
    shiftKey: boolean;
    preventDefault: () => void;
  }) {
    if (!(event.metaKey || event.ctrlKey)) return false;
    if (event.key.toLowerCase() === "y") {
      event.preventDefault();
      act(onQuery);
      return true;
    }
    if (event.key.toLowerCase() === "r") {
      event.preventDefault();
      act(() => {
        void load();
      });
      return true;
    }
    if (event.shiftKey && [".", ">"].includes(event.key)) {
      event.preventDefault();
      act(closeDatabase);
      return true;
    }
    return false;
  }
  function openMenu(x: number, y: number) {
    setDumpOpen(false);
    setMenu({
      x: Math.max(8, Math.min(x, window.innerWidth - 288)),
      y: Math.max(
        8,
        Math.min(
          y,
          window.innerHeight - Math.min(430, window.innerHeight * 0.85) - 8,
        ),
      ),
    });
  }
  useEffect(() => {
    if (!menu) return;
    const close = () => setMenu(null);
    const escape = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        close();
        toggleButton.current?.focus();
      }
    };
    window.addEventListener("mousedown", close);
    window.addEventListener("keydown", escape);
    window.addEventListener("resize", close);
    return () => {
      window.removeEventListener("mousedown", close);
      window.removeEventListener("keydown", escape);
      window.removeEventListener("resize", close);
    };
  }, [menu]);
  function act(action: () => void) {
    setMenu(null);
    toggleButton.current?.focus();
    action();
  }
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const tree = session.trees?.[database];
  const request = useRef(0);
  useEffect(() => {
    request.current++;
    setError("");
    setLoading(false);
  }, [session.explorerVersion]);
  async function load() {
    const version = ++request.current;
    setLoading(true);
    setError("");
    try {
      const tree = await explorerSchema(session.id, database);
      if (request.current !== version) return;
      const state = useWorkspace.getState();
      const current = state.sessions.find((s) => s.id === session.id);
      if (current)
        state.updateSession(session.id, {
          trees: { ...current.trees, [database]: tree },
        });
    } catch (e) {
      if (request.current === version) setError(String(e));
    } finally {
      if (request.current === version) setLoading(false);
    }
  }
  useEffect(() => {
    if (tree || loading || error || (!expanded && !term)) return;
    const timer = window.setTimeout(() => void load(), term ? 250 : 0);
    return () => window.clearTimeout(timer);
  }, [expanded, tree, loading, error, term]);
  const tables = tree ? matchingTables(database, tree.tables, term) : [];
  if (term && tree && !database.toLowerCase().includes(term) && !tables.length)
    return null;
  return (
    <div className="database-branch" ref={branch}>
      <div
        className="database-node"
        onKeyDown={shortcut}
        onContextMenu={(event) => {
          event.preventDefault();
          const rect = event.currentTarget.getBoundingClientRect();
          openMenu(
            event.clientX || rect.left + 16,
            event.clientY || rect.bottom,
          );
        }}
      >
        <button
          className="tiny-button database-expand"
          aria-label={`${open ? "Collapse" : "Expand"} database ${database}`}
          aria-expanded={open}
          onClick={() =>
            term ? setSearchCollapsed(!searchCollapsed) : setExpanded(!expanded)
          }
        >
          {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        </button>
        <button
          ref={toggleButton}
          className="database-toggle"
          onKeyDown={(event) => {
            if (
              event.key === "ContextMenu" ||
              (event.shiftKey && event.key === "F10")
            ) {
              event.preventDefault();
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu(rect.left + 16, rect.bottom);
            }
          }}
          aria-expanded={open}
          onClick={() => {
            setExpanded(true);
            setSearchCollapsed(false);
            onBrowse();
          }}
        >
          <Layers size={13} />
          <span title={database}>{database}</span>
        </button>
        <div className="database-actions">
          <button
            className="icon-button"
            aria-label={`New table in ${database}`}
            title="New Table"
            onClick={() => void onDatabaseAction("new-table")}
          >
            <Table2 size={12} />
          </button>
          <button
            className="icon-button"
            aria-label={`Refresh ${database}`}
            disabled={loading}
            onClick={() => void load()}
          >
            <RefreshCw size={12} className={loading ? "spin" : ""} />
          </button>
          <button
            className="icon-button"
            aria-label={`Actions for database ${database}`}
            aria-haspopup="menu"
            aria-expanded={!!menu}
            onClick={(event) => {
              const rect = event.currentTarget.getBoundingClientRect();
              openMenu(rect.left, rect.bottom + 4);
            }}
          >
            <MoreHorizontal size={12} />
          </button>
        </div>
      </div>
      {menu &&
        createPortal(
          <div
            className="grid-context-menu database-context-menu"
            role="menu"
            aria-label={`${database} database actions`}
            style={{ left: menu.x, top: menu.y }}
            onScroll={() => setDumpOpen(false)}
            onMouseDown={(event) => event.stopPropagation()}
            onKeyDown={(event) => {
              if (shortcut(event)) return;
              if (
                event.key === "ArrowRight" &&
                (event.target as HTMLElement).getAttribute("data-dump") ===
                  "true"
              ) {
                event.preventDefault();
                showDump(event.target as HTMLElement);
                return;
              }
              if (event.key === "ArrowLeft" && dumpOpen) {
                event.preventDefault();
                setDumpOpen(false);
                event.currentTarget
                  .querySelector<HTMLButtonElement>("[data-dump]")
                  ?.focus();
                return;
              }
              if (event.key === "Escape" && dumpOpen) {
                event.preventDefault();
                event.stopPropagation();
                setDumpOpen(false);
                event.currentTarget
                  .querySelector<HTMLButtonElement>("[data-dump]")
                  ?.focus();
                return;
              }
              if (event.key === "Tab") {
                event.preventDefault();
                setMenu(null);
                toggleButton.current?.focus();
                return;
              }
              if (!["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key))
                return;
              event.preventDefault();
              const activeMenu =
                (event.target as HTMLElement).closest<HTMLElement>(
                  '[role="menu"]',
                ) ?? event.currentTarget;
              const items = Array.from(
                activeMenu.querySelectorAll<HTMLButtonElement>(
                  "button:not(:disabled)",
                ),
              );
              const index = items.indexOf(
                document.activeElement as HTMLButtonElement,
              );
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? items.length - 1
                    : (index +
                        (event.key === "ArrowDown" ? 1 : -1) +
                        items.length) %
                      items.length;
              items[next]?.focus();
            }}
          >
            <button
              role="menuitem"
              autoFocus
              onClick={() => act(closeDatabase)}
            >
              <span>Close Database</span>
              <kbd>{mac ? "⇧⌘." : "Ctrl+Shift+."}</kbd>
            </button>
            <div className="context-separator" role="separator" />
            <button
              role="menuitem"
              disabled={sqlite || system}
              title={
                sqlite
                  ? "SQLite database files are managed through connections"
                  : system
                    ? "System database settings are protected"
                    : undefined
              }
              onClick={() =>
                act(() => {
                  void onDatabaseAction("edit");
                })
              }
            >
              Edit Database…
            </button>
            <button
              role="menuitem"
              disabled={sqlite}
              title={
                sqlite
                  ? "Create a SQLite file through a new connection"
                  : undefined
              }
              onClick={() =>
                act(() => {
                  void onDatabaseAction("new");
                })
              }
            >
              New Database…
            </button>
            <button
              role="menuitem"
              disabled={sqlite || system}
              title={
                sqlite
                  ? "SQLite file deletion is not available here"
                  : system
                    ? "System databases cannot be deleted"
                    : undefined
              }
              onClick={() =>
                act(() => {
                  void onDatabaseAction("delete");
                })
              }
            >
              Delete Database
            </button>
            <div className="context-separator" role="separator" />
            <button
              role="menuitem"
              onClick={() =>
                act(() => {
                  void onDatabaseAction("new-table");
                })
              }
            >
              New Table…
            </button>
            <button role="menuitem" onClick={() => act(onQuery)}>
              <span>New Query</span>
              <kbd>{mod}Y</kbd>
            </button>
            <div className="context-separator" role="separator" />
            <button
              role="menuitem"
              onClick={() =>
                act(() => {
                  void onDatabaseAction("execute-file");
                })
              }
            >
              Execute SQL File…
            </button>
            <button
              role="menuitem"
              data-dump="true"
              aria-haspopup="menu"
              aria-expanded={dumpOpen}
              onMouseEnter={(event) => showDump(event.currentTarget)}
              onClick={(event) => {
                if (dumpOpen) setDumpOpen(false);
                else showDump(event.currentTarget);
              }}
            >
              <span>Dump SQL File</span>
              <ChevronRight size={16} />
            </button>
            {dumpOpen &&
              createPortal(
                <div
                  ref={dumpMenu}
                  className="grid-context-menu database-dump-submenu"
                  style={{ left: dumpAnchor.x, top: dumpAnchor.y }}
                  role="menu"
                  aria-label="Dump SQL File options"
                >
                  <button
                    role="menuitem"
                    autoFocus
                    onClick={() =>
                      act(() => {
                        void onDatabaseAction("dump-structure");
                      })
                    }
                  >
                    Structure Only
                  </button>
                  <button
                    role="menuitem"
                    onClick={() =>
                      act(() => {
                        void onDatabaseAction("dump-data");
                      })
                    }
                  >
                    Structure and Data
                  </button>
                </div>,
                document.body,
              )}
            <button
              role="menuitem"
              onClick={() =>
                act(() => {
                  void onDatabaseAction("find");
                })
              }
            >
              Find in Database…
            </button>
            <div className="context-separator" role="separator" />
            <button
              role="menuitem"
              onClick={() =>
                act(() => {
                  void onDatabaseAction("share");
                })
              }
            >
              Share…
            </button>
            <div className="context-separator" role="separator" />
            <button
              role="menuitem"
              disabled={loading}
              onClick={() =>
                act(() => {
                  void load();
                })
              }
            >
              <span>Refresh</span>
              <kbd>{mod}R</kbd>
            </button>
          </div>,
          document.body,
        )}
      {error && !open && (
        <div className="tree-error" role="alert">
          {error}
        </div>
      )}
      {open && (
        <>
          {loading && !tree && (
            <div className="empty-inline" role="status">
              Loading tables…
            </div>
          )}
          {error && <div className="tree-error">{error}</div>}
          {tree && (
            <>
              <div className="tree-section">
                Tables & views <span>{tables.length}</span>
              </div>
              {tables.map((t) => (
                <ExplorerTable
                  key={`${t.schema}.${t.name}`}
                  session={session}
                  table={t}
                  database={database}
                  onOpen={() => onOpen(t)}
                  onAction={(action) => onAction(t, action)}
                  onMaintain={
                    onMaintain
                      ? (operation) => onMaintain(t, operation)
                      : undefined
                  }
                />
              ))}
              {!tree.tables.length && (
                <div className="empty-inline">No tables yet.</div>
              )}
            </>
          )}
          {children}
        </>
      )}
    </div>
  );
}
export default function App() {
  const w = useWorkspace();
  const detached =
    w.singleTab || (api.desktop && location.hash === "#detached");
  const tabDrag = useTabDrag(w.reorderTab, w.setActive);
  const tab = w.tabs.find((t) => t.id === w.activeTab);
  const session =
    w.sessions.find((s) => s.id === tab?.connectionId) ?? w.sessions[0];
  const [modal, setModal] = useState(false);
  const [databaseToolsOpen, setDatabaseToolsOpen] = useState(false);
  const [databaseToolsPane, setDatabaseToolsPane] =
    useState<DatabaseToolPane>("Data Transfer");
  const [areaMenu, setAreaMenu] = useState<AreaMenu | null>(null);
  const [tabMenu, setTabMenu] = useState<TabMenuTarget | null>(null);
  const closeTabMenu = useCallback(() => setTabMenu(null), []);
  const [reveal, setReveal] = useState<{
    connectionId: string;
    database: string;
    table?: TableInfo;
    nonce: number;
  }>();
  const [favorites, setFavorites] = useState<TabFavorite[]>(() => {
    try {
      return readTabFavorites(localStorage.getItem("dbde.tab-favorites"));
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("dbde.tab-favorites", JSON.stringify(favorites));
    } catch {
      /* Storage may be unavailable. */
    }
  }, [favorites]);
  useEffect(() => {
    const sync = (event: StorageEvent) => {
      if (event.key === "dbde.tab-favorites")
        setFavorites(readTabFavorites(event.newValue));
    };
    window.addEventListener("storage", sync);
    return () => window.removeEventListener("storage", sync);
  }, []);
  const library = useQueryLibrary((message) => setNotice(message), favorites);
  const savedQueriesRef = useRef(library.savedQueries);
  savedQueriesRef.current = library.savedQueries;
  const [libraryPanel, setLibraryPanel] = useState<
    "history" | "queries" | "snippets" | null
  >(null);
  const [saveDialog, setSaveDialog] = useState<{
    mode: "save" | "saveAs" | "rename";
    profileId: string;
    database: string;
    initialName: string;
    initialDescription?: string;
    tabId?: string;
    query?: SavedQuery;
  } | null>(null);
  const [unsavedRequest, setUnsavedRequest] = useState<{
    name: string;
    action: string;
    resolve: (choice: UnsavedChoice) => void;
  } | null>(null);
  const [chooseRequest, setChooseRequest] = useState<{
    reason: string;
    resolve: (target: { id: string; database?: string } | null) => void;
  } | null>(null);
  const cancelRequested = useRef(new Set<string>());
  const editorDriver = session?.config.driver ?? "sqlite";
  const editorSnippets = useMemo(
    () => snippetsFor(editorDriver, library.snippets),
    [editorDriver, library.snippets],
  );
  useEffect(() => {
    if (detached) return;
    const open = (event: KeyboardEvent) => {
      const panel = libraryShortcutFromKey(event);
      if (!panel || document.querySelector('[aria-modal="true"]')) return;
      event.preventDefault();
      event.stopPropagation();
      setLibraryPanel(panel);
    };
    window.addEventListener("keydown", open, true);
    return () => window.removeEventListener("keydown", open, true);
  }, [detached]);
  useEffect(() => {
    const design = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        !(event.metaKey || event.ctrlKey) ||
        event.key.toLowerCase() !== "d" ||
        event.shiftKey ||
        event.altKey ||
        document.querySelector('[aria-modal="true"]')
      )
        return;
      const target = event.target instanceof Element ? event.target : null;
      // Lists and grids handle their own selected object; text editors retain native keys.
      if (
        target?.closest(
          ".results, .database-tables, .monaco-editor, aside, [role='dialog'], .modal, [role='menu'], input, textarea, select, [contenteditable='true']",
        )
      )
        return;
      const source = tab?.result?.source;
      if (!source || !session) return;
      event.preventDefault();
      event.stopPropagation();
      if (!tab.running)
        void tableAction(session, source.database, source.table, "structure");
    };
    window.addEventListener("keydown", design, true);
    return () => window.removeEventListener("keydown", design, true);
  }, [tab, session]);
  const [profiles, setProfiles] = useState<ConnectionConfig[]>([]);
  const autoConnectAttempted = useRef(new Set<string>());
  const [connectionMenu, setConnectionMenu] =
    useState<ConnectionMenuTarget | null>(null);
  const [connectionEditor, setConnectionEditor] = useState<{
    mode: "edit" | "duplicate";
    config: ConnectionConfig;
    original: ConnectionConfig;
    sessionId?: string;
  } | null>(null);
  const [connectionActionDialog, setConnectionActionDialog] = useState<{
    mode: "group" | "execute-file";
    session: Session;
  } | null>(null);
  const [appearance, setAppearance] = useState<
    Record<string, ConnectionAppearance>
  >(() => {
    try {
      return readConnectionAppearance(
        localStorage.getItem("dbde.connection-appearance"),
      );
    } catch {
      return {};
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem(
        "dbde.connection-appearance",
        JSON.stringify(appearance),
      );
    } catch {
      /* Appearance is optional in private browsing. */
    }
  }, [appearance]);
  const connectionGroups = [
    ...new Set(
      Object.values(appearance)
        .map((value) => value.group)
        .filter((value): value is string => !!value),
    ),
  ].sort();
  const orderedSessions = [...w.sessions].sort(
    (a, b) =>
      (appearance[a.config.id]?.group ?? "").localeCompare(
        appearance[b.config.id]?.group ?? "",
      ) ||
      Number(!!appearance[b.config.id]?.starred) -
        Number(!!appearance[a.config.id]?.starred),
  );
  const connectionActionsPending = useRef(new Set<string>());
  function patchAppearance(id: string, patch: ConnectionAppearance) {
    setAppearance((current) => ({
      ...current,
      [id]: { ...current[id], ...patch },
    }));
  }
  function showConnectionMenu(
    config: ConnectionConfig,
    sessionId: string | undefined,
    element: HTMLElement,
    x?: number,
    y?: number,
  ) {
    const box = element.getBoundingClientRect();
    setConnectionMenu({
      config,
      sessionId,
      trigger: element,
      x: x ?? box.left + 12,
      y: y ?? box.bottom + 4,
    });
  }
  function connectionShortcut(
    event: React.KeyboardEvent<HTMLElement>,
    config: ConnectionConfig,
    sessionId?: string,
  ) {
    if (
      event.key === "ContextMenu" ||
      (event.shiftKey && event.key === "F10")
    ) {
      event.preventDefault();
      showConnectionMenu(config, sessionId, event.currentTarget);
      return;
    }
    if (!(event.metaKey || event.ctrlKey)) return;
    const action =
      event.key.toLowerCase() === "y"
        ? "query"
        : event.key.toLowerCase() === "r"
          ? "refresh"
          : event.shiftKey && [".", ">"].includes(event.key)
            ? "close"
            : undefined;
    if (action) {
      event.preventDefault();
      const box = event.currentTarget.getBoundingClientRect();
      void connectionAction(
        {
          config,
          sessionId,
          trigger: event.currentTarget,
          x: box.left,
          y: box.bottom,
        },
        action,
      );
    }
  }
  const [search, setSearch] = useState("");
  const [noticeState, updateNotice] = useState<{
    text: string;
    tone: "error" | "success" | "info";
  }>({ text: "", tone: "info" });
  const notice = noticeState.text;
  const noticeDismiss = useAutoDismiss(
    noticeState,
    () => updateNotice({ text: "", tone: "info" }),
    !!notice && noticeState.tone !== "error",
  );
  function setNotice(
    text: string,
    tone: "error" | "success" | "info" = "error",
  ) {
    updateNotice({ text, tone });
  }
  const [tableTool, setTableTool] = useState<TableToolRequest | null>(null);
  const [tableClipboard, setTableClipboard] = useState<TableClipboard | null>(
    null,
  );
  const [pasteRequest, setPasteRequest] = useState<{
    source: TableClipboard;
    target: Session;
    database: string;
  } | null>(null);
  async function copyTables(
    session: Session,
    database: string,
    tables: TableInfo[],
  ) {
    try {
      if (tables.some((table) => table.kind !== "table"))
        throw new Error(
          "Copy/paste supports tables. Use View DDL to copy a view definition.",
        );
      if (tables.length > 100)
        throw new Error("Copy up to 100 tables at a time.");
      const text = tables.map((table) => table.name).join("\n");
      await writeClipboard(text);
      setTableClipboard({
        connectionId: session.id,
        database,
        tables: tables.map((table) => ({ ...table })),
        text,
      });
      setNotice(
        `${tables.length} table(s) copied. Open the destination database and paste.`,
        "success",
      );
    } catch (cause) {
      setNotice(String(cause));
    }
  }
  async function pasteTables(
    target: Session,
    database: string,
    clipboardText?: string,
  ) {
    try {
      if (!tableClipboard)
        throw new Error("Select and copy tables from a database list first.");
      if (
        !useWorkspace
          .getState()
          .sessions.some(
            (session) => session.id === tableClipboard.connectionId,
          )
      )
        throw new Error(
          "The source connection was closed. Reconnect and copy the tables again.",
        );
      let text = clipboardText;
      if (text === undefined && navigator.clipboard?.readText)
        text = await navigator.clipboard.readText();
      if (
        text !== undefined &&
        text.replace(/\r\n/g, "\n") !== tableClipboard.text
      )
        throw new Error(
          "The clipboard contains different content. Copy the tables again before pasting.",
        );
      setPasteRequest({ source: tableClipboard, target, database });
    } catch (cause) {
      setNotice(String(cause));
    }
  }

  const [tableDesigner, setTableDesigner] =
    useState<TableDesignerRequest | null>(null);
  const [tableStructure, setTableStructure] =
    useState<TableStructureRequest | null>(null);
  const [renameRequest, setRenameRequest] = useState<{
    session: Session;
    database: string;
    table: TableInfo;
  } | null>(null);
  const [ddlView, setDdlView] = useState<{
    session: Session;
    database: string;
    table: TableInfo;
    ddl: string;
    /** Set for routines, triggers, events, sequences and materialized views. */
    object?: { kindLabel: string; note: string | null; fileName: string };
  } | null>(null);
  const [sequenceReset, setSequenceReset] = useState<{
    sequence: DbObject;
    resolve: (value: string | null) => void;
  } | null>(null);
  const [maintainResult, setMaintainResult] = useState<{
    label: string;
    database: string;
    result: MaintainResult;
  } | null>(null);
  const [exportRequest, setExportRequest] = useState<ExportRequest | null>(
    null,
  );
  const [importRequest, setImportRequest] = useState<{
    session: Session;
    database: string;
    table: TableInfo;
  } | null>(null);
  const [databaseDialog, setDatabaseDialog] = useState<DatabaseRequest | null>(
    null,
  );
  const [databaseUtility, setDatabaseUtility] =
    useState<DatabaseUtilityRequest | null>(null);
  const databasePending = useRef(new Set<string>());
  const tableActionBusy = useRef(false);
  const [shortcuts, setShortcuts] = useState<TableShortcut[]>(() => {
    try {
      const value = JSON.parse(
        localStorage.getItem("dbde.table-shortcuts") ?? "[]",
      );
      return Array.isArray(value)
        ? value
            .filter(
              (x) =>
                typeof x?.profile_id === "string" &&
                typeof x?.database === "string" &&
                typeof x?.table?.name === "string" &&
                typeof x?.table?.schema === "string" &&
                typeof x?.table?.kind === "string",
            )
            .slice(0, 100)
        : [];
    } catch {
      return [];
    }
  });
  useEffect(() => {
    try {
      localStorage.setItem("dbde.table-shortcuts", JSON.stringify(shortcuts));
    } catch {
      /* Private browsing may disable storage. */
    }
  }, [shortcuts]);
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [help, setHelp] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth > 520,
  );
  const detachedTable =
    detached && !!(tab?.result?.source || tab?.tableIdentity);
  const [focusPreference, setTableFocus] = useState(detachedTable);
  const tableFocus = detached || focusPreference;
  const previousTab = useRef(tab?.id);
  const editorOpen = (tab?.editorOpen ?? !tab?.result?.source) && !tableFocus;
  useEffect(() => {
    if (previousTab.current !== tab?.id) setTableFocus(false);
    previousTab.current = tab?.id;
  }, [tab?.id]);
  useEffect(() => {
    if (!detachedTable || !tableFocus) return;
    const frame = requestAnimationFrame(() =>
      document
        .querySelector<HTMLElement>(
          '.result-table [role="cell"][tabindex="0"], [role="cell"][tabindex="0"]',
        )
        ?.focus({ preventScroll: true }),
    );
    return () => cancelAnimationFrame(frame);
  }, [detachedTable, tableFocus, tab?.id]);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const pending = useRef(new Set<string>());
  const closingTabs = useRef(false);
  useEffect(() => {
    document
      .querySelectorAll<HTMLButtonElement>(".tabs [role=tab]")
      .forEach((button) => {
        if (button.getAttribute("aria-selected") === "true")
          button.scrollIntoView?.({ block: "nearest", inline: "nearest" });
      });
  }, [w.activeTab]);
  useEffect(() => {
    if (!api.desktop || location.hash !== "#detached") return;
    let stopped = false;
    let cleanup: (() => void) | undefined;
    void api
      .guardDetachedWindowClose(async () => {
        const tabs = useWorkspace.getState().tabs;
        if (tabs.some((tab) => tab.running)) {
          setNotice("Wait for running queries before closing this window.");
          return false;
        }
        if (!(await confirmUnsavedQueries(tabs, "Closing the window")))
          return false;
        if (!(await confirmDiscardStaged(tabs, "Closing the window")))
          return false;
        return confirmRollback(tabs, "Closing the window");
      })
      .then((unlisten) => {
        if (stopped) unlisten();
        else cleanup = unlisten;
      })
      .catch((cause) => setNotice(String(cause)));
    return () => {
      stopped = true;
      cleanup?.();
    };
  }, []);
  const [confirmRequest, setConfirmRequest] = useState<
    (ConfirmRequest & { resolve: (confirmed: boolean) => void }) | null
  >(null);
  function confirmAction(request: ConfirmRequest) {
    return new Promise<boolean>((resolve) =>
      setConfirmRequest({ ...request, resolve }),
    );
  }
  const driverOf = (connectionId: string) =>
    useWorkspace.getState().sessions.find((s) => s.id === connectionId)?.config
      .driver ?? "sqlite";
  // PostgreSQL and MySQL tabs own a server session; SQLite shares one connection.
  const ownsSession = (t: QueryTab) =>
    t.kind !== "database" &&
    api.desktop &&
    driverOf(t.connectionId) !== "sqlite";
  async function confirmRollback(tabs: QueryTab[], action: string) {
    const open = (
      await Promise.all(
        tabs.filter(ownsSession).map((t) =>
          api
            .sessionInTransaction(t.connectionId, t.id)
            .catch(() => false)
            .then((inTransaction) => (inTransaction ? t : undefined)),
        ),
      )
    ).filter((t): t is QueryTab => !!t);
    if (!open.length) return true;
    return confirmAction({
      title: "Roll back the open transaction?",
      body: `${open.length === 1 ? "This tab has" : `${open.length} tabs have`} uncommitted changes. ${action} rolls them back. Run COMMIT first to keep them.`,
      confirmLabel: "Roll back and continue",
      details: open.map((t) => t.name),
    });
  }
  // Grid changes not yet written (Navicat's pending record edits or open transaction).
  async function confirmDiscardStaged(tabs: QueryTab[], action: string) {
    const pending = tabs.filter((t) => t.staged && pendingCount(t.staged));
    if (!pending.length) return true;
    return confirmAction({
      title: "Discard unsaved table changes?",
      body: `${pending.length === 1 ? "This tab has" : `${pending.length} tabs have`} table changes that were not saved. ${action} discards them. Press Ctrl/⌘+S (or Commit) first to keep them.`,
      confirmLabel: "Discard changes",
      details: pending.map(
        (t) => `${t.name}: ${pendingCount(t.staged!)} change(s)`,
      ),
    });
  }
  function connectionName(profileId: string) {
    return (
      useWorkspace
        .getState()
        .sessions.find((session) => session.config.id === profileId)?.config
        .name ??
      profiles.find((profile) => profile.id === profileId)?.name ??
      "Unknown connection"
    );
  }
  /** Asks to save or discard saved-query edits; false cancels the action. */
  async function confirmUnsavedQueries(tabs: QueryTab[], action: string) {
    for (const t of tabs.filter(tabHasUnsavedQuery)) {
      const choice = await new Promise<UnsavedChoice>((resolve) =>
        setUnsavedRequest({ name: t.name, action, resolve }),
      );
      setUnsavedRequest(null);
      if (choice === "cancel") return false;
      if (choice === "discard") continue;
      const saved = savedQueriesRef.current.find(
        (query) => query.id === t.savedQueryId,
      );
      if (!saved) {
        // Deleted elsewhere: ask for a name instead of closing.
        await saveTabQuery(t.id, "save");
        return false;
      }
      try {
        await storeTabQuery(t, saved);
      } catch (cause) {
        setNotice(String(cause));
        return false;
      }
    }
    return true;
  }
  async function storeTabQuery(t: QueryTab, saved: SavedQuery) {
    const query = t.query;
    await library.saveQueries([{ ...saved, query, updated_at: Date.now() }]);
    useWorkspace.getState().updateTab(t.id, { savedQuerySql: query });
  }
  /** Save (Ctrl/⌘+S) or Save as (Ctrl/⌘+Shift+S) for a query tab. */
  async function saveTabQuery(tabId: string, mode: "save" | "saveAs") {
    const state = useWorkspace.getState();
    const t = state.tabs.find((item) => item.id === tabId);
    if (!t || t.kind === "database") return;
    const s = state.sessions.find((item) => item.id === t.connectionId);
    if (!s) return;
    const saved = savedQueriesRef.current.find(
      (query) => query.id === t.savedQueryId,
    );
    if (mode === "save" && saved) {
      try {
        await storeTabQuery(t, saved);
        setNotice(`Saved query ${saved.name}.`, "success");
      } catch (cause) {
        setNotice(String(cause));
      }
      return;
    }
    const database = saved?.database ?? t.database ?? s.config.database ?? "";
    setSaveDialog({
      mode,
      tabId,
      profileId: s.config.id,
      database,
      initialName: uniqueQueryName(
        saved ? `${saved.name} copy` : t.name,
        savedQueriesRef.current,
        s.config.id,
        database,
      ),
      initialDescription: saved?.description,
    });
  }
  async function submitSaveDialog(value: {
    name: string;
    description: string;
  }) {
    const request = saveDialog;
    if (!request) return;
    if (request.mode === "rename" && request.query) {
      await library.saveQueries([
        {
          ...request.query,
          name: value.name,
          description: value.description || undefined,
          updated_at: Date.now(),
        },
      ]);
      for (const t of useWorkspace.getState().tabs)
        if (t.savedQueryId === request.query.id)
          w.updateTab(t.id, { name: value.name });
      setFavorites((old) =>
        old.map((favorite) =>
          favorite.id === request.query!.id
            ? { ...favorite, name: value.name }
            : favorite,
        ),
      );
      setSaveDialog(null);
      return;
    }
    const t = useWorkspace
      .getState()
      .tabs.find((item) => item.id === request.tabId);
    if (!t) throw new Error("The query tab was closed.");
    const now = Date.now();
    const saved: SavedQuery = {
      id: crypto.randomUUID(),
      profile_id: request.profileId,
      database: request.database,
      name: value.name,
      description: value.description || undefined,
      query: t.query,
      created_at: now,
      updated_at: now,
    };
    await library.saveQueries([saved]);
    w.updateTab(t.id, {
      savedQueryId: saved.id,
      savedQuerySql: saved.query,
      name: saved.name,
    });
    setSaveDialog(null);
    setNotice(`Saved query ${saved.name}.`, "success");
  }
  /** An open session for a profile: connects a saved profile, or asks for one. */
  async function sessionForProfile(
    profileId: string,
    database: string,
    reason: string,
  ): Promise<{ id: string; database?: string } | null> {
    const state = useWorkspace.getState();
    const open = state.sessions.find((item) => item.config.id === profileId);
    if (open) return { id: open.id, database: database || undefined };
    const profile = profiles.find((item) => item.id === profileId);
    if (profile && !detached) {
      const id = await api.connect(profile);
      connected(id, profile);
      return { id, database: database || undefined };
    }
    if (!state.sessions.length)
      throw new Error("Connect to a database first to open this SQL.");
    return new Promise((resolve) => setChooseRequest({ reason, resolve }));
  }
  async function openSavedQuery(query: SavedQuery) {
    try {
      const existing = useWorkspace
        .getState()
        .tabs.find((t) => t.savedQueryId === query.id);
      if (existing) {
        w.setActive(existing.id);
        setLibraryPanel(null);
        return;
      }
      const target = await sessionForProfile(
        query.profile_id,
        query.database,
        `The connection of “${query.name}” is not available. Choose where to open it.`,
      );
      if (!target) return;
      w.addTab(target.id, query.query, query.name, target.database);
      w.updateTab(useWorkspace.getState().activeTab, {
        savedQueryId: query.id,
        savedQuerySql: query.query,
      });
      setLibraryPanel(null);
    } catch (cause) {
      setNotice(String(cause));
    }
  }
  async function deleteSavedQuery(query: SavedQuery) {
    if (
      !(await confirmAction({
        title: `Delete saved query “${query.name}”?`,
        body: "The saved SQL is removed for every window. Open tabs keep their text as an unsaved query.",
        confirmLabel: "Delete query",
      }))
    )
      return;
    try {
      await library.deleteQueries([query.id]);
      for (const t of useWorkspace.getState().tabs)
        if (t.savedQueryId === query.id)
          w.updateTab(t.id, {
            savedQueryId: undefined,
            savedQuerySql: undefined,
            favoriteId: undefined,
          });
      setFavorites((old) => old.filter((favorite) => favorite.id !== query.id));
    } catch (cause) {
      setNotice(String(cause));
    }
  }
  async function duplicateQuery(query: SavedQuery) {
    try {
      await library.saveQueries([
        duplicateSavedQuery(query, savedQueriesRef.current, Date.now()),
      ]);
    } catch (cause) {
      setNotice(String(cause));
    }
  }
  async function openHistoryEntry(entry: HistoryEntry) {
    try {
      const target = await sessionForProfile(
        entry.profile_id,
        entry.database,
        `${entry.connection_name} is not available. Choose where to open this SQL.`,
      );
      if (!target) return;
      w.addTab(target.id, entry.sql, "History query", target.database);
      setLibraryPanel(null);
    } catch (cause) {
      setNotice(String(cause));
    }
  }
  /** Inserts SQL at the editor cursor, or appends it when no editor is shown. */
  function insertSql(text: string, asSnippet: boolean) {
    const state = useWorkspace.getState();
    const current = state.tabs.find((t) => t.id === state.activeTab);
    if (!current || current.kind === "database") return;
    setLibraryPanel(null);
    const instance = editorOpen ? editor.current : null;
    if (instance)
      requestAnimationFrame(() => insertIntoEditor(instance, text, asSnippet));
    else
      w.updateTab(current.id, {
        editorOpen: true,
        query: appendSql(current.query, asSnippet ? expandSnippet(text) : text),
      });
  }
  async function clearAllHistory() {
    if (
      await confirmAction({
        title: "Clear query history?",
        body: "Every recorded statement is deleted for all windows. Saved queries are not affected.",
        confirmLabel: "Clear history",
      })
    )
      await library.clearHistory();
  }
  async function deleteUserSnippet(snippet: Snippet) {
    if (
      !(await confirmAction({
        title: `Delete snippet “${snippet.name}”?`,
        body: `The ${snippet.prefix} prefix stops offering this snippet in every window.`,
        confirmLabel: "Delete snippet",
      }))
    )
      return;
    await library.deleteSnippet(snippet.id).catch((cause) => {
      setNotice(String(cause));
    });
  }
  async function closeQueryTab(t: QueryTab) {
    await closeWorkspaceTabs([t]);
  }
  async function closeWorkspaceTabs(tabs: QueryTab[]) {
    if (closingTabs.current) return;
    closingTabs.current = true;
    try {
      if (!tabs.length) return;
      const ids = tabs.map((tab) => tab.id);
      const current = () =>
        useWorkspace.getState().tabs.filter((tab) => ids.includes(tab.id));
      if (current().some((tab) => tab.running)) {
        setNotice(
          "Wait for running queries to finish before closing these tabs.",
        );
        return;
      }
      if (
        !(await confirmUnsavedQueries(
          current(),
          ids.length === 1 ? "Closing the tab" : "Closing these tabs",
        ))
      )
        return;
      if (!(await confirmDiscardStaged(current(), "Closing tabs"))) return;
      if (!(await confirmRollback(current(), "Closing tabs"))) return;
      if (current().some((tab) => tab.running)) {
        setNotice("A query started while confirming. Wait for it to finish.");
        return;
      }
      for (const tab of current().filter((tab) => tab.kind !== "database")) {
        await api.closeSession(tab.connectionId, tab.id);
      }
      w.closeTabs(ids);
      if (detached && !useWorkspace.getState().tabs.length)
        await api.closeDetachedWindow();
    } catch (cause) {
      setNotice(String(cause));
    } finally {
      closingTabs.current = false;
    }
  }
  async function openFavorite(favorite: TabFavorite) {
    try {
      let current = useWorkspace
        .getState()
        .sessions.find((session) => session.config.id === favorite.profile_id);
      if (!current) {
        const profile = profiles.find(
          (profile) => profile.id === favorite.profile_id,
        );
        if (!profile)
          throw new Error("Connect the saved profile for this favorite first.");
        const id = await api.connect(profile);
        connected(id, profile);
        current = useWorkspace
          .getState()
          .sessions.find((session) => session.id === id);
      }
      if (!current) return;
      const saved =
        favorite.kind === "query"
          ? savedQueriesRef.current.find((query) => query.id === favorite.id)
          : undefined;
      if (saved) {
        await openSavedQuery(saved);
        return;
      }
      if (favorite.kind === "database")
        w.openDatabaseTab(current.id, favorite.database);
      else if (favorite.kind === "table" && favorite.table)
        await openTable(current, favorite.table, favorite.database);
      else {
        const existing = useWorkspace
          .getState()
          .tabs.find(
            (tab) =>
              tab.connectionId === current!.id &&
              tab.favoriteId === favorite.id,
          );
        if (existing) w.setActive(existing.id);
        else {
          w.addTab(
            current.id,
            favorite.query,
            favorite.name,
            favorite.database,
          );
          w.updateTab(useWorkspace.getState().activeTab, {
            favoriteId: favorite.id,
          });
        }
      }
    } catch (cause) {
      setNotice(String(cause));
    }
  }
  async function tabAction(id: string, action: TabAction) {
    tabMenu?.trigger.focus();
    closeTabMenu();
    const state = useWorkspace.getState();
    const target = state.tabs.find((tab) => tab.id === id);
    if (!target) return;
    const current = state.sessions.find(
      (session) => session.id === target.connectionId,
    );
    try {
      if (
        action === "close" ||
        action === "others" ||
        action === "right" ||
        action === "all"
      ) {
        await closeWorkspaceTabs(tabsToClose(state.tabs, id, action));
        return;
      }
      if (!current) return;
      if (action === "favorite") {
        const favorite = favoriteFor(target, current);
        setFavorites((old) =>
          old.some((item) => item.id === favorite.id)
            ? old.filter((item) => item.id !== favorite.id)
            : [...old, favorite].slice(-100),
        );
        if (favorite.kind === "query") {
          w.updateTab(id, { favoriteId: favorite.id });
          // A query favorite pins a saved query; favoriting an unsaved tab saves it.
          const adding = !favorites.some((item) => item.id === favorite.id);
          if (
            adding &&
            !savedQueriesRef.current.some((item) => item.id === favorite.id)
          ) {
            const now = Date.now();
            const saved: SavedQuery = {
              id: favorite.id,
              profile_id: favorite.profile_id,
              database: favorite.database,
              name: uniqueQueryName(
                target.name,
                savedQueriesRef.current,
                favorite.profile_id,
                favorite.database,
              ),
              query: target.query,
              created_at: now,
              updated_at: now,
            };
            w.updateTab(id, {
              savedQueryId: saved.id,
              savedQuerySql: saved.query,
              name: saved.name,
            });
            void library
              .saveQueries([saved])
              .catch((cause) => setNotice(String(cause)));
          }
        }
      } else if (action === "reveal") {
        if (detached) return;
        setExplorerOpen(true);
        setTableFocus(false);
        setSearch("");
        setCollapsed((old) => old.filter((value) => value !== current.id));
        setReveal({
          connectionId: current.id,
          database: target.database ?? current.config.database,
          table:
            target.result?.source?.table ??
            (target.tableIdentity
              ? { ...target.tableIdentity, kind: "table" }
              : undefined),
          nonce: Date.now(),
        });
      } else if (action === "move") {
        if (detached) return;
        if (target.kind === "database") return;
        if (target.running || pending.current.has(id)) return;
        pending.current.add(id);
        w.updateTab(id, { running: true, cancellable: false });
        try {
          await api.moveTabToWindow(current, target);
          w.closeTabs([id]);
        } finally {
          pending.current.delete(id);
          w.updateTab(id, { running: false });
        }
      }
    } catch (cause) {
      setNotice(String(cause));
    }
  }
  async function changeDatabase(t: QueryTab, database: string) {
    if (detached) return;
    if (!(await confirmDiscardStaged([t], "Switching the database"))) return;
    if (!(await confirmRollback([t], "Switching the database"))) return;
    // Release the old database's connection now rather than on the next run.
    void api
      .closeSession(t.connectionId, t.id)
      .catch((e) => setNotice(String(e)));
    w.updateTab(t.id, { database, result: undefined, error: undefined });
  }
  useEffect(() => {
    let stopped = false;
    void api
      .listProfiles()
      .then(async (loaded) => {
        if (stopped) return;
        setProfiles(loaded);
        if (!api.desktop || detached) return;
        for (const profile of loaded.filter(
          (profile) => profile.options?.auto_connect,
        )) {
          if (stopped) break;
          if (autoConnectAttempted.current.has(profile.id)) continue;
          autoConnectAttempted.current.add(profile.id);
          try {
            const id = await api.connect(profile);
            if (!stopped) connected(id, profile);
            else if (
              !useWorkspace
                .getState()
                .sessions.some((session) => session.id === id)
            )
              await api.disconnect(id);
          } catch (cause) {
            if (!stopped)
              setNotice(`Auto-connect ${profile.name}: ${String(cause)}`);
          }
        }
      })
      .catch((cause) => {
        if (!stopped) setNotice(String(cause));
      });
    return () => {
      stopped = true;
    };
  }, []);
  async function refresh(id: string) {
    useWorkspace
      .getState()
      .updateSession(id, { loading: true, error: undefined });
    try {
      const config = useWorkspace
        .getState()
        .sessions.find((s) => s.id === id)?.config;
      const databases =
        configuredDatabases(config) ?? (await api.listDatabases(id));
      const state = useWorkspace.getState();
      state.updateSession(id, { databases });
      for (const queryTab of state.tabs.filter(
        (t) => t.connectionId === id && !t.database,
      )) {
        const config = state.sessions.find((s) => s.id === id)?.config;
        state.updateTab(queryTab.id, {
          database: databases.includes(config?.database ?? "")
            ? config!.database
            : databases[0],
        });
      }
    } catch (e) {
      useWorkspace.getState().updateSession(id, { error: String(e) });
    } finally {
      useWorkspace.getState().updateSession(id, { loading: false });
    }
  }
  function connected(id: string, config: ConnectionConfig) {
    config = withoutSecrets(config);
    const state = useWorkspace.getState();
    const existing = state.sessions.find(
      (s) => s.id === id || connectionKey(s.config) === connectionKey(config),
    );
    if (existing) {
      setCollapsed((old) => old.filter((value) => value !== existing.id));
      setExplorerOpen(true);
      const open =
        state.tabs.find(
          (t) => t.connectionId === existing.id && t.id === state.activeTab,
        ) ?? state.tabs.find((t) => t.connectionId === existing.id);
      if (open) state.setActive(open.id);
      else
        state.addTab(
          existing.id,
          undefined,
          "Query 1",
          existing.config.database || undefined,
        );
      void api
        .listProfiles()
        .then(setProfiles)
        .catch((e) => setNotice(String(e)));
      return;
    }
    w.addSession({ id, config });
    w.addTab(
      id,
      config.driver === "sqlite"
        ? "SELECT name, type\nFROM sqlite_master\nWHERE type = 'table';"
        : "SELECT 1 AS connected;",
      "Query 1",
    );
    void refresh(id);
    void api
      .listProfiles()
      .then(setProfiles)
      .catch((e) => setNotice(String(e)));
  }
  async function openDemo() {
    if (w.sessions.some((s) => s.id === "demo")) return;
    connected("demo", api.demoConfig);
    const state = useWorkspace.getState();
    const id = state.activeTab;
    state.updateTab(id, {
      name: "Customer overview",
      query:
        "-- A little clarity in every query.\nSELECT id, name, email, plan, status, created_at\nFROM customers\nORDER BY id\nLIMIT 1000;",
    });
    await refresh("demo");
    const current = useWorkspace.getState().tabs.find((t) => t.id === id)!;
    await runQuery(current.id, current.connectionId, current.query);
  }
  async function runQuery(
    id: string,
    connectionId: string,
    query: string,
    database?: string,
  ) {
    if (pending.current.has(id) || !query.trim()) return;
    const beforeRun = useWorkspace.getState().tabs.find((t) => t.id === id);
    if (!beforeRun || !(await confirmDiscardStaged([beforeRun], "Running SQL")))
      return;
    if (
      pending.current.has(id) ||
      !useWorkspace.getState().tabs.some((t) => t.id === id)
    )
      return;
    pending.current.add(id);
    cancelRequested.current.delete(id);
    const current = useWorkspace.getState().tabs.find((t) => t.id === id);
    const startedAt = Date.now();
    const started = performance.now();
    let outcome: { result?: QueryResult; error?: string } = {};
    w.updateTab(id, {
      running: true,
      cancellable: api.desktop && driverOf(connectionId) !== "sqlite",
      error: undefined,
      tableIdentity: undefined,
      staged: undefined,
      resultView: "result",
    });
    try {
      // The tab ID pins a server session so transactions and SET persist between runs.
      const result = await api.execute(
        connectionId,
        query,
        database,
        id,
        current?.timeoutSecs,
      );
      useWorkspace.getState().updateTab(id, { result });
      outcome = { result };
      // Edit/New object scripts run here; reload object lists they may have changed.
      if (/\b(CREATE|ALTER|DROP|REFRESH)\b/i.test(query)) {
        const ran = useWorkspace
          .getState()
          .sessions.find((item) => item.id === connectionId);
        if (ran)
          invalidateObjects(connectionId, database ?? ran.config.database);
      }
    } catch (e) {
      useWorkspace
        .getState()
        .updateTab(id, { error: String(e), result: undefined });
      outcome = { error: String(e) };
    } finally {
      pending.current.delete(id);
      useWorkspace
        .getState()
        .updateTab(id, { running: false, cancellable: false });
      const ran = useWorkspace
        .getState()
        .sessions.find((item) => item.id === connectionId);
      if (ran)
        library.recordHistory(
          historyEntry({
            at: startedAt,
            profileId: ran.config.id,
            connectionName: ran.config.name,
            database: database ?? ran.config.database,
            sql: query,
            durationMs:
              outcome.result?.execution_ms ?? performance.now() - started,
            result: outcome.result,
            error: outcome.error,
            cancelled: cancelRequested.current.delete(id),
          }),
        );
    }
  }
  async function run(selection?: string) {
    if (!tab || tab.running || tab.kind === "database") return;
    const selected =
      selection ??
      (editor.current?.getSelection()
        ? editor.current
            .getModel()
            ?.getValueInRange(editor.current.getSelection()!)
        : "");
    const query = selected?.trim() ? selected : tab.query;
    const risky = destructiveStatements(query, driverOf(tab.connectionId));
    if (
      risky.length &&
      !(await confirmAction({
        title: "Run destructive SQL?",
        body: "These statements drop objects or change every row of a table. They cannot be undone unless you run them inside a transaction and roll it back.",
        confirmLabel: "Run anyway",
        details: risky,
      }))
    )
      return;
    void runQuery(tab.id, tab.connectionId, query, tab.database);
  }
  /**
   * Explains the selected statement, or the one under the cursor, on the tab's own
   * session. Plain EXPLAIN never runs it; Analyze does, so writes need a confirmation
   * (PostgreSQL rolls them back) and are refused on MySQL/MariaDB.
   */
  async function explainQuery() {
    if (!tab || tab.running || tab.kind === "database") return;
    const current = tab;
    const driver = driverOf(current.connectionId);
    const model = editor.current?.getModel();
    const selection = editor.current?.getSelection();
    let range: { start: number; end: number } | undefined;
    let cursor: number | undefined;
    if (model && selection) {
      const start = model.getOffsetAt(selection.getStartPosition());
      const end = model.getOffsetAt(selection.getEndPosition());
      if (end > start) range = { start, end };
      cursor = model.getOffsetAt(selection.getPosition());
    }
    const target = explainTarget(
      model?.getValue() ?? current.query,
      driver,
      range,
      cursor,
    );
    if ("error" in target) {
      setNotice(target.error);
      return;
    }
    const analyze = !!current.explainAnalyze && driver !== "sqlite";
    let allowWrite = false;
    if (analyze && !isReadOnlyStatement(target.statement, driver)) {
      if (driver === "mysql") {
        setNotice(
          "Analyze runs the statement, and MySQL/MariaDB cannot reliably roll writes back (DDL and non-transactional engines commit implicitly). Turn off Analyze to see the estimated plan.",
        );
        return;
      }
      if (
        !(await confirmAction({
          title: "Run this statement to analyze it?",
          body: "EXPLAIN ANALYZE executes the statement to measure it. DBde runs it in a transaction (a savepoint if this tab has one open) and rolls it back. Rows stay locked until then, and effects outside the transaction, such as sequence values, NOTIFY or external calls, are not undone.",
          confirmLabel: "Analyze and roll back",
          details: [explainSql(target.statement, driver, true)],
        }))
      )
        return;
      allowWrite = true;
    }
    if (pending.current.has(current.id)) return;
    pending.current.add(current.id);
    cancelRequested.current.delete(current.id);
    w.updateTab(current.id, {
      running: true,
      cancellable: api.desktop && driver !== "sqlite",
    });
    try {
      const output = await api.explain(
        current.connectionId,
        target.statement,
        current.database,
        current.id,
        analyze,
        allowWrite,
        current.timeoutSecs,
      );
      useWorkspace.getState().updateTab(current.id, {
        plan: { output, statement: target.statement, driver },
        resultView: "plan",
      });
    } catch (e) {
      setNotice(`Explain failed: ${String(e)}`);
    } finally {
      pending.current.delete(current.id);
      useWorkspace
        .getState()
        .updateTab(current.id, { running: false, cancellable: false });
    }
  }
  /**
   * Navicat's Maintain submenu. Long-locking operations show their SQL first and roll back
   * this app's own open transactions, so they cannot wait on (or deadlock with) them.
   */
  async function maintainTables(
    s: Session,
    database: string,
    tables: TableInfo[],
    operation: MaintainOperation,
  ) {
    const driver = s.config.driver;
    const info = maintainInfo(operation, driver);
    if (!info || tableActionBusy.current) return;
    tableActionBusy.current = true;
    try {
      const targets = info.databaseWide
        ? []
        : tables.filter((table) => table.kind === "table");
      if (
        operation === "repair" &&
        targets.some(
          (table) =>
            !repairableEngine(
              s.trees?.[database]?.table_metadata?.find(
                (item) =>
                  item.name === table.name && item.schema === table.schema,
              )?.engine,
            ),
        )
      )
        throw new Error(
          "REPAIR TABLE works only on MyISAM, Aria, ARCHIVE and CSV tables. Use Check or Optimize for InnoDB tables.",
        );
      const statements = maintainSql(operation, driver, targets);
      const subject = info.databaseWide
        ? database
        : targets.length === 1
          ? targets[0].name
          : `${targets.length} tables`;
      const configured = s.config.options?.query_timeout_secs;
      // Rebuilds can take long; give them at least ten minutes before cancelling.
      const timeoutSecs = info.locking
        ? Math.max(configured ?? 0, 600)
        : configured;
      if (info.locking) {
        const related = useWorkspace
          .getState()
          .tabs.filter(
            (t) =>
              t.connectionId === s.id &&
              (t.database === database ||
                t.tableIdentity?.database === database),
          );
        if (related.some((t) => t.running))
          throw new Error(
            "Wait for running queries on this database to finish.",
          );
        if (
          !(await confirmAction({
            title: `${info.label} ${subject}?`,
            body: `${info.warning} It is cancelled on the server after ${Math.round((timeoutSecs ?? 600) / 60)} minutes.`,
            confirmLabel: `Run ${info.label}`,
            details: statements,
          }))
        )
          return;
        const affected = info.databaseWide
          ? related
          : related.filter((t) =>
              targets.some(
                (table) =>
                  (t.tableIdentity?.schema === table.schema &&
                    t.tableIdentity?.name === table.name) ||
                  (t.result?.source?.table.schema === table.schema &&
                    t.result.source.table.name === table.name),
              ),
            );
        if (!(await confirmDiscardStaged(affected, `Running ${info.label}`)))
          return;
        if (!(await confirmRollback(related, `Running ${info.label}`))) return;
        for (const t of affected)
          if (t.staged) w.updateTab(t.id, { staged: undefined });
        for (const t of related.filter(ownsSession))
          await api.closeSession(t.connectionId, t.id);
      }
      setNotice(`Running ${info.label} on ${subject}…`, "info");
      const result = await api.maintainTables(
        s.id,
        database,
        targets,
        operation,
        timeoutSecs,
      );
      setNotice(`${info.label} finished on ${subject}.`, "success");
      setMaintainResult({ label: info.label, database, result });
      invalidateDatabase(s.id, database);
    } catch (e) {
      setNotice(String(e));
    } finally {
      tableActionBusy.current = false;
    }
  }
  async function tableAction(
    s: Session,
    database: string,
    table: TableInfo,
    action: TableAction,
  ) {
    const driver = s.config.driver;
    if (tableActionBusy.current) return;
    tableActionBusy.current = true;
    try {
      if (action === "view" || action === "quick")
        return openTable(s, table, database, action === "quick");
      if (action === "shortcut") {
        setShortcuts((old) =>
          [
            ...old.filter(
              (x) =>
                !(
                  x.profile_id === s.config.id &&
                  x.database === database &&
                  x.table.name === table.name &&
                  x.table.schema === table.schema
                ),
            ),
            { profile_id: s.config.id, database, table },
          ].slice(-100),
        );
        setNotice(`Pinned ${table.name} to table shortcuts.`, "success");
        return;
      }
      if (action === "refresh") {
        invalidateDatabase(s.id, database);
        return;
      }
      if (
        action === "copy" ||
        action === "copy-data" ||
        action === "transfer"
      ) {
        setTableTool({
          session: s,
          database,
          table,
          mode: action === "transfer" ? "transfer" : "copy",
          data: action === "copy-data",
        });
        return;
      }
      if (action === "rename") {
        setRenameRequest({ session: s, database, table });
        return;
      }
      if (action === "ddl") {
        const ddl = await api.tableDdl(s.id, table, database);
        setDdlView({ session: s, database, table, ddl });
        return;
      }
      if (action === "export-data") {
        const info = await api.columns(s.id, table, database);
        if (!info.length)
          throw new Error(`No columns found for ${table.name}.`);
        setExportRequest({
          connectionId: s.id,
          database,
          driver,
          table,
          columns: info.map((column) => column.name),
        });
        return;
      }
      if (action === "import") {
        if (table.kind !== "table")
          throw new Error("Data can only be imported into a table.");
        setImportRequest({ session: s, database, table });
        return;
      }
      if (action === "export" || action === "dump") {
        setNotice(`Preparing SQL dump for ${table.name}…`, "info");
        const ddl = await dumpTable(
          s.id,
          database,
          table,
          driver,
          action === "dump",
        );
        const saved = await api.saveFile(`${table.name}.sql`, "sql", ddl);
        setNotice(
          saved ? `SQL saved to ${saved}` : "SQL export cancelled.",
          saved ? "success" : "info",
        );
        return;
      }
      if (action === "structure") {
        setTableStructure({ session: s, database, table });
        return;
      }
      const related = useWorkspace
        .getState()
        .tabs.filter(
          (t) =>
            t.connectionId === s.id &&
            (t.database === database || t.tableIdentity?.database === database),
        );
      if (related.some((t) => t.running))
        throw new Error("Wait for running queries on this database to finish.");
      const affected = related.filter(
        (t) =>
          (t.tableIdentity?.schema === table.schema &&
            t.tableIdentity?.name === table.name) ||
          (t.result?.source?.table.schema === table.schema &&
            t.result.source.table.name === table.name),
      );
      const sql = tableActionSql(action, table, driver);
      const kind = table.kind === "view" ? "view" : "table";
      let foreignKeyChecks: ForeignKeyChecks = "default";
      if (
        !(await confirmAction({
          title:
            action === "drop"
              ? `Are you sure you want to delete "${table.name}"?`
              : `${action === "empty" ? "Empty" : "Truncate"} ${table.name}?`,
          body:
            action === "drop"
              ? `Permanently removes the ${kind} and its data from ${database}. Dependencies may block this action.`
              : `Permanently deletes every row in ${database}.${table.name}. ${action === "empty" ? "Auto-generated counters are preserved. DELETE triggers will run." : "Auto-generated counters are reset. Foreign keys may block this action."}`,
          confirmLabel:
            action === "drop"
              ? "Delete"
              : action === "empty"
                ? "Empty table"
                : "Truncate table",
          details: [sql],
          ...(action === "drop"
            ? {
                tableDeletion: {
                  allowForeignKeyChecks:
                    driver === "mysql" && table.kind === "table",
                  onForeignKeyChecks: (mode: ForeignKeyChecks) => {
                    foreignKeyChecks = mode;
                  },
                },
              }
            : {}),
        }))
      )
        return;
      if (
        !(await confirmDiscardStaged(
          affected,
          action === "drop" ? "Dropping the table" : "Deleting all records",
        ))
      )
        return;
      if (!(await confirmRollback(related, "Changing this table"))) return;
      for (const t of related.filter(ownsSession))
        await api.closeSession(t.connectionId, t.id);
      if (action === "drop")
        await api.dropTable(s.id, database, table, foreignKeyChecks);
      else await api.clearTable(s.id, database, table, action === "truncate");
      invalidateDatabase(s.id, database);
      for (const t of affected) {
        if (action === "drop") w.closeTab(t.id);
        else {
          w.updateTab(t.id, { staged: undefined });
          await runTableView(t.id, s.id, database, table);
        }
      }
      setNotice(
        action === "drop"
          ? `Dropped ${table.name}.`
          : `Deleted all rows in ${table.name}.`,
        "success",
      );
    } catch (e) {
      setNotice(String(e));
    } finally {
      tableActionBusy.current = false;
    }
  }
  /**
   * Renames a table, then moves everything that refers to it: open tabs (reloaded
   * under the new name), pinned shortcuts and favorites. Rejects with the reason, which
   * the rename dialog shows, when the user cancels a prompt or the database refuses.
   */
  async function renameTableTo(
    request: { session: Session; database: string; table: TableInfo },
    newName: string,
  ) {
    const { session: s, database, table } = request;
    const related = useWorkspace
      .getState()
      .tabs.filter(
        (t) =>
          t.connectionId === s.id &&
          (t.database === database || t.tableIdentity?.database === database),
      );
    if (related.some((t) => t.running))
      throw new Error("Wait for running queries on this database to finish.");
    const affected = related.filter(
      (t) =>
        (t.tableIdentity?.schema === table.schema &&
          t.tableIdentity?.name === table.name) ||
        (t.result?.source?.table.schema === table.schema &&
          t.result.source.table.name === table.name),
    );
    if (!(await confirmDiscardStaged(affected, "Renaming the table")))
      throw new Error("Rename cancelled. Unsaved table changes were kept.");
    // ALTER/RENAME waits for locks held by open transactions in other tabs.
    if (!(await confirmRollback(related, "Renaming the table")))
      throw new Error("Rename cancelled. Open transactions were kept.");
    for (const t of related.filter(ownsSession))
      await api.closeSession(t.connectionId, t.id);
    const renamed = await api.renameTable(s.id, database, table, newName);
    invalidateDatabase(s.id, database);
    const same = (other?: TableInfo) =>
      other?.schema === table.schema && other?.name === table.name;
    setShortcuts((current) =>
      current.map((shortcut) =>
        shortcut.profile_id === s.config.id &&
        shortcut.database === database &&
        same(shortcut.table)
          ? { ...shortcut, table: { ...shortcut.table, name: renamed.name } }
          : shortcut,
      ),
    );
    setFavorites((current) =>
      current.map((favorite) =>
        favorite.kind === "table" &&
        favorite.profile_id === s.config.id &&
        favorite.database === database &&
        same(favorite.table)
          ? {
              ...favorite,
              // The id embeds the table name, so it is rebuilt for the new name.
              id: JSON.stringify([
                s.config.id,
                "table",
                database,
                table.schema,
                renamed.name,
              ]),
              name: favorite.name === table.name ? renamed.name : favorite.name,
              table: { ...favorite.table!, name: renamed.name },
            }
          : favorite,
      ),
    );
    setRenameRequest(null);
    for (const t of affected) {
      w.updateTab(t.id, {
        staged: undefined,
        name: t.name === table.name ? renamed.name : t.name,
        ...(t.tableIdentity
          ? { tableIdentity: { ...t.tableIdentity, name: renamed.name } }
          : {}),
      });
      if (t.result?.source)
        await runTableView(t.id, s.id, database, {
          ...t.result.source.table,
          name: renamed.name,
        });
    }
    setNotice(`Renamed ${table.name} to ${renamed.name}.`, "success");
  }
  // Tabs on the import's database, and those showing the target table.
  function importTabs(request: {
    session: Session;
    database: string;
    table: TableInfo;
  }) {
    const { session: s, database, table } = request;
    const related = useWorkspace
      .getState()
      .tabs.filter(
        (t) =>
          t.connectionId === s.id &&
          (t.database === database || t.tableIdentity?.database === database),
      );
    const affected = related.filter(
      (t) =>
        (t.tableIdentity?.schema === table.schema &&
          t.tableIdentity?.name === table.name) ||
        (t.result?.source?.table.schema === table.schema &&
          t.result.source.table.name === table.name),
    );
    return { related, affected };
  }
  /**
   * Before an import writes to the table: unsaved grid edits on it are discarded and
   * open transactions on the database rolled back (their locks would block the import),
   * after confirmation, as for renaming or emptying a table.
   */
  async function prepareImport(request: {
    session: Session;
    database: string;
    table: TableInfo;
  }) {
    const { related, affected } = importTabs(request);
    if (related.some((t) => t.running))
      throw new Error("Wait for running queries on this database to finish.");
    if (!(await confirmDiscardStaged(affected, "Importing into the table")))
      return false;
    if (!(await confirmRollback(related, "Importing into the table")))
      return false;
    for (const t of related.filter(ownsSession))
      await api.closeSession(t.connectionId, t.id);
    return true;
  }
  async function finishImport(
    request: { session: Session; database: string; table: TableInfo },
    summary: ImportSummary,
  ) {
    const { session: s, database, table } = request;
    invalidateDatabase(s.id, database);
    setNotice(`${table.name}: ${importSummaryText(summary)}`, "success");
    for (const t of importTabs(request).affected) {
      w.updateTab(t.id, { staged: undefined });
      const source = t.result?.source;
      if (source)
        await runTableView(
          t.id,
          s.id,
          database,
          source.table,
          t.result?.pagination?.page ?? 1,
          t.result?.pagination?.page_size ?? 1000,
          source.filters ?? [],
          source.sort,
        );
    }
  }
  function invalidateDatabase(connectionId: string, database: string) {
    const state = useWorkspace.getState();
    const trees = {
      ...state.sessions.find((s) => s.id === connectionId)?.trees,
    };
    delete trees[database];
    state.updateSession(connectionId, { trees });
    invalidateObjects(connectionId, database);
  }
  /** Reloads routine, trigger, event, sequence and materialized view lists that are shown. */
  function invalidateObjects(connectionId: string, database: string) {
    const state = useWorkspace.getState();
    const objects = {
      ...state.sessions.find((s) => s.id === connectionId)?.objects,
    };
    if (!(database in objects)) return;
    delete objects[database];
    state.updateSession(connectionId, { objects });
  }
  function newObject(s: Session, database: string, kind: ObjectKind) {
    try {
      w.addTab(
        s.id,
        newObjectTemplate(kind, s.config.driver),
        `New ${OBJECT_LABELS[kind].one}`,
        database,
      );
    } catch (e) {
      setNotice(String(e));
    }
  }
  /**
   * Actions on a database object. Definitions open read-only; Edit, Execute and New open
   * SQL tabs without running anything; statements are built and validated by the backend,
   * shown verbatim for confirmation, and only then run.
   */
  async function objectAction(
    s: Session,
    database: string,
    object: DbObject,
    action: ObjectAction,
  ) {
    const driver = s.config.driver;
    const label = OBJECT_LABELS[object.kind].one;
    if (tableActionBusy.current) return;
    tableActionBusy.current = true;
    try {
      if (action === "new") return newObject(s, database, object.kind);
      if (action === "copy-name") {
        await writeClipboard(objectSqlName(object, driver));
        setNotice(`Copied ${objectSqlName(object, driver)}.`, "success");
        return;
      }
      if (action === "open-data")
        return openTable(
          s,
          { name: object.name, schema: object.schema, kind: "view" },
          database,
        );
      if (action === "view" || action === "edit" || action === "execute") {
        const found = await api.objectDefinition(s.id, database, object);
        if (action === "view") {
          setDdlView({
            session: s,
            database,
            table: {
              name: objectLabel(object),
              schema: object.schema,
              kind: object.kind,
            },
            ddl: found.definition,
            object: {
              kindLabel: label.toLowerCase(),
              note: found.note ?? null,
              fileName: object.name,
            },
          });
        } else if (action === "edit") {
          w.addTab(s.id, found.edit_script, `Edit · ${object.name}`, database);
        } else {
          if (!found.execute_script)
            throw new Error(found.note ?? `This ${label} cannot be executed.`);
          w.addTab(
            s.id,
            found.execute_script,
            `Execute · ${object.name}`,
            database,
          );
        }
        return;
      }
      let statement: ObjectStatementAction;
      let value: string | undefined;
      if (action === "reset") {
        const picked = await new Promise<string | null>((resolve) =>
          setSequenceReset({ sequence: object, resolve }),
        );
        setSequenceReset(null);
        if (picked === null) return;
        statement = "restart";
        value = picked;
      } else if (action === "refresh-concurrently")
        statement = "refresh_concurrently";
      else statement = action;
      const sql = await api.objectAction(s.id, database, object, statement, {
        value,
        preview: true,
      });
      const name = objectLabel(object);
      const toggle = statement === "enable" || statement === "disable";
      const related = useWorkspace
        .getState()
        .tabs.filter(
          (t) =>
            t.connectionId === s.id &&
            (t.database === database || t.tableIdentity?.database === database),
        );
      // Tabs showing a materialized view's data, closed when it is dropped.
      const affected =
        object.kind === "materialized_view"
          ? related.filter(
              (t) =>
                (t.tableIdentity?.schema === object.schema &&
                  t.tableIdentity?.name === object.name) ||
                (t.result?.source?.table.schema === object.schema &&
                  t.result.source.table.name === object.name),
            )
          : [];
      if (!toggle) {
        if (related.some((t) => t.running))
          throw new Error(
            "Wait for running queries on this database to finish.",
          );
        const prompts: Record<
          Exclude<ObjectStatementAction, "enable" | "disable">,
          { title: string; body: string; confirm: string }
        > = {
          drop: {
            title: `Drop ${label.toLowerCase()} "${name}"?`,
            body: `Permanently removes the ${label.toLowerCase()} from ${database}. ${object.kind === "function" || object.kind === "procedure" ? "Triggers, views or code that call it stop working." : object.kind === "materialized_view" ? "Its stored rows are deleted; dependent views block this action." : "This cannot be undone."}`,
            confirm: `Drop ${label}`,
          },
          refresh: {
            title: `Refresh ${name}?`,
            body: "Recomputes every row. Reads of this materialized view wait until the refresh finishes.",
            confirm: "Refresh",
          },
          refresh_concurrently: {
            title: `Refresh ${name} concurrently?`,
            body: "Recomputes every row while readers keep seeing the old rows. It takes longer than a plain refresh and cannot run inside a transaction.",
            confirm: "Refresh concurrently",
          },
          restart: {
            title: `Reset sequence ${name}?`,
            body: `The next value is ${value}. Existing rows keep their values, so restarting below the highest used value can cause duplicate key errors.`,
            confirm: "Reset sequence",
          },
        };
        const prompt = prompts[statement as keyof typeof prompts];
        if (
          !(await confirmAction({
            title: prompt.title,
            body: prompt.body,
            confirmLabel: prompt.confirm,
            details: [sql],
          }))
        )
          return;
        if (!(await confirmDiscardStaged(affected, `Changing ${name}`))) return;
        // DDL waits for locks held by open transactions in other tabs.
        if (!(await confirmRollback(related, `Changing ${name}`))) return;
        for (const t of related.filter(ownsSession))
          await api.closeSession(t.connectionId, t.id);
      }
      if (statement !== "drop" && statement !== "restart" && !toggle)
        setNotice(`Refreshing ${name}…`, "info");
      await api.objectAction(s.id, database, object, statement, { value });
      invalidateObjects(s.id, database);
      if (statement === "drop") for (const t of affected) w.closeTab(t.id);
      setNotice(
        statement === "drop"
          ? `Dropped ${name}.`
          : statement === "restart"
            ? `Sequence ${name} restarts with ${value}.`
            : toggle
              ? `${statement === "enable" ? "Enabled" : "Disabled"} event ${name}.`
              : `Refreshed ${name}.`,
        "success",
      );
    } catch (e) {
      setNotice(String(e));
    } finally {
      tableActionBusy.current = false;
    }
  }
  async function openShortcut(shortcut: TableShortcut) {
    try {
      let s = useWorkspace
        .getState()
        .sessions.find((s) => s.config.id === shortcut.profile_id);
      if (!s) {
        const config = profiles.find((p) => p.id === shortcut.profile_id);
        if (!config)
          throw new Error("Connect the saved profile for this shortcut first.");
        const id = await api.connect(config);
        connected(id, config);
        s = useWorkspace.getState().sessions.find((s) => s.id === id);
      }
      if (s) openTable(s, shortcut.table, shortcut.database);
    } catch (e) {
      setNotice(String(e));
    }
  }
  function databaseTabs(session: Session, database: string) {
    return useWorkspace
      .getState()
      .tabs.filter(
        (t) =>
          t.connectionId === session.id &&
          (t.database ?? session.config.database) === database,
      );
  }
  async function prepareDatabaseClose(session: Session, database: string) {
    const tabs = databaseTabs(session, database);
    if (tabs.some((t) => t.running))
      throw new Error("Wait for running queries in this database to finish.");
    if (!(await confirmUnsavedQueries(tabs, "Closing this database")))
      return false;
    if (!(await confirmDiscardStaged(tabs, "Closing this database")))
      return false;
    if (!(await confirmRollback(tabs, "Closing this database"))) return false;
    return true;
  }
  function clearDatabaseTabs(session: Session, database: string) {
    for (const tab of databaseTabs(session, database)) w.closeTab(tab.id);
    invalidateDatabase(session.id, database);
  }
  async function updateInitialDatabase(
    session: Session,
    previous: string,
    database: string,
  ): Promise<string> {
    const listed = session.config.options?.database_list?.some(
      (entry) => entry.name === previous,
    );
    if (session.config.database !== previous && !listed) return "";
    const databaseList = session.config.options?.database_list?.flatMap(
      (entry) =>
        entry.name !== previous
          ? [entry]
          : database
            ? [{ ...entry, name: database }]
            : [],
    );
    const config = {
      ...session.config,
      database:
        session.config.database === previous
          ? database
          : session.config.database,
      database_only: !!database && session.config.database_only,
      ...(listed
        ? {
            options: {
              ...session.config.options,
              database_list: databaseList,
              custom_database_list:
                !!databaseList?.length &&
                session.config.options?.custom_database_list,
            },
          }
        : {}),
    };
    w.updateSession(session.id, { config });
    if (profiles.some((profile) => profile.id === config.id)) {
      try {
        await api.saveProfile(config);
        setProfiles(await api.listProfiles());
      } catch (e) {
        return ` Saved profile could not be updated: ${String(e)}`;
      }
    }
    return "";
  }
  async function saveDatabase(change: api.DatabaseChange) {
    const request = databaseDialog!;
    const { session, database, mode } = request;
    if (
      mode === "edit" &&
      session.config.driver === "postgres" &&
      !(await prepareDatabaseClose(session, database))
    )
      throw new Error("Rename cancelled. No database changes were applied.");
    await api.manageDatabase(session.id, database, mode, change);
    let profileWarning = "";
    if (mode === "edit" && session.config.driver === "postgres") {
      clearDatabaseTabs(session, database);
      setShortcuts((old) =>
        old.map((item) =>
          item.profile_id === session.config.id && item.database === database
            ? { ...item, database: change.name }
            : item,
        ),
      );
      profileWarning = await updateInitialDatabase(
        session,
        database,
        change.name,
      );
    }
    await refresh(session.id);
    setNotice(
      (mode === "create"
        ? `Created database ${change.name}.`
        : `Updated database ${change.name}.`) + profileWarning,
      profileWarning ? "info" : "success",
    );
  }
  async function databaseAction(
    session: Session,
    database: string,
    action: DatabaseAction,
  ): Promise<boolean> {
    const key = `${session.id}:${database}`;
    if (databasePending.current.has(key)) return false;
    databasePending.current.add(key);
    try {
      if (action === "new-table") {
        setTableDesigner({ session, database });
        return true;
      }
      if (action === "new" || action === "edit") {
        setDatabaseDialog({
          session,
          database,
          mode: action === "new" ? "create" : "edit",
        });
        return true;
      }
      if (action === "find" || action === "share") {
        setDatabaseUtility({ session, database, mode: action });
        return true;
      }
      if (action === "close") {
        if (!(await prepareDatabaseClose(session, database))) return false;
        await api.closeDatabase(session.id, database);
        clearDatabaseTabs(session, database);
        return true;
      }
      if (action === "delete") {
        if (
          !(await confirmAction({
            title: `Delete database ${database}?`,
            body: "This permanently deletes the entire database, all tables and all records. This action cannot be undone.",
            confirmLabel: "Delete Database",
            details: [database],
          }))
        )
          return false;
        if (!(await prepareDatabaseClose(session, database))) return false;
        await api.manageDatabase(session.id, database, "delete", {
          name: database,
          charset: "",
          collation: "",
        });
        clearDatabaseTabs(session, database);
        setShortcuts((old) =>
          old.filter(
            (item) =>
              !(
                item.profile_id === session.config.id &&
                item.database === database
              ),
          ),
        );
        const profileWarning = await updateInitialDatabase(
          session,
          database,
          "",
        );
        await refresh(session.id);
        setNotice(
          `Deleted database ${database}.${profileWarning}`,
          profileWarning ? "info" : "success",
        );
        return true;
      }
      if (action === "dump-structure" || action === "dump-data") {
        setNotice(`Preparing SQL dump for ${database}…`, "info");
        const contents = await dumpDatabase(
          session,
          database,
          action === "dump-data",
        );
        const saved = await api.saveFile(
          databaseFileName(database, "sql"),
          "sql",
          contents,
        );
        setNotice(
          saved ? `SQL saved to ${saved}` : "SQL export cancelled.",
          saved ? "success" : "info",
        );
        return !!saved;
      }
      const file = await api.openSqlFile();
      if (!file) return false;
      w.addTab(session.id, file.contents, file.name, database);
      const id = useWorkspace.getState().activeTab;
      if (
        !(await confirmAction({
          title: `Execute ${file.name}?`,
          body: `The script will run against ${database}. SQL can change or delete data. Cancel to review the complete script in the SQL editor first. Statements may commit separately.`,
          confirmLabel: "Execute SQL",
          details: [file.contents.slice(0, 2000)],
        }))
      )
        return false;
      const related = databaseTabs(session, database).filter(
        (t) => t.id !== id,
      );
      if (related.some((t) => t.running))
        throw new Error("Wait for running queries in this database to finish.");
      if (!(await confirmDiscardStaged(related, "Executing the SQL file")))
        return false;
      if (!(await confirmRollback(related, "Executing the SQL file")))
        return false;
      await api.closeDatabase(session.id, database);
      for (const t of related) w.updateTab(t.id, { staged: undefined });
      await runQuery(id, session.id, file.contents, database);
      invalidateDatabase(session.id, database);
      await refresh(session.id);
      return true;
    } catch (e) {
      setNotice(String(e));
      return false;
    } finally {
      databasePending.current.delete(key);
    }
  }
  async function prepareConnectionClose(
    id: string,
    action: string,
  ): Promise<boolean> {
    const tabs = useWorkspace
      .getState()
      .tabs.filter((t) => t.connectionId === id);
    if (tabs.some((t) => t.running)) {
      setNotice(
        "Wait for running queries to finish before changing this connection.",
      );
      return false;
    }
    if (!(await confirmUnsavedQueries(tabs, action))) return false;
    if (!(await confirmDiscardStaged(tabs, action))) return false;
    return confirmRollback(tabs, action);
  }
  async function closeConnection(id: string): Promise<boolean> {
    if (!(await prepareConnectionClose(id, "Disconnecting"))) return false;
    try {
      await api.disconnect(id);
      w.removeSession(id);
      return true;
    } catch (e) {
      setNotice(String(e));
      return false;
    }
  }
  async function submitConnectionChanges(
    config: ConnectionConfig,
    save: boolean,
  ) {
    const request = connectionEditor!;
    if (request.mode === "duplicate") {
      if (!save)
        throw new Error(
          "Enable Save duplicate to keep the new connection profile.",
        );
      await api.testConnection(config);
      await api.saveProfile(config);
      setProfiles(await api.listProfiles());
      patchAppearance(config.id, { ...appearance[request.original.id] });
      setNotice(`Connection ${config.name} duplicated.`, "success");
      return;
    }
    const current = useWorkspace
      .getState()
      .sessions.find((s) => s.id === request.sessionId);
    const metadataOnly =
      current &&
      connectionKey(current.config) === connectionKey(config) &&
      current.config.database === config.database &&
      config.password === undefined &&
      config.options?.ssh?.password === undefined;
    if (!current || metadataOnly) {
      if (!current) {
        if (!save)
          throw new Error("Save this profile to retain the edited connection.");
        await api.testConnection(config);
      }
      if (save) await api.saveProfile(config);
      if (current)
        w.updateSession(current.id, {
          config: withoutSecrets(config),
        });
      setProfiles(await api.listProfiles());
      setNotice(`Connection ${config.name} updated.`, "success");
      return;
    }
    const conflict = useWorkspace
      .getState()
      .sessions.find(
        (s) =>
          s.id !== current.id &&
          connectionKey(s.config) === connectionKey(config),
      );
    if (conflict)
      throw new Error(
        `This connection is already open as ${conflict.config.name}.`,
      );
    if (!(await prepareConnectionClose(current.id, "Editing the connection")))
      throw new Error(
        "Connection edit cancelled. Current connection kept open.",
      );
    let replacement: string | undefined;
    try {
      replacement = await api.connectFresh(config);
      if (save) await api.saveProfile(config);
      await api.disconnect(current.id);
      w.removeSession(current.id);
      connected(replacement, withoutSecrets(config));
      setNotice(`Connection ${config.name} updated.`, "success");
    } catch (cause) {
      if (
        replacement &&
        !useWorkspace.getState().sessions.some((s) => s.id === replacement)
      )
        await api.disconnect(replacement).catch(() => {});
      throw cause;
    }
  }
  async function activeConnection(
    target: ConnectionMenuTarget,
  ): Promise<Session> {
    const existing = useWorkspace
      .getState()
      .sessions.find((s) => s.id === target.sessionId);
    if (existing) return existing;
    const id = await api.connect(target.config);
    connected(id, target.config);
    const current = useWorkspace.getState().sessions.find((s) => s.id === id);
    if (!current) throw new Error("Connection is not available.");
    return current;
  }
  async function connectionAction(
    target: ConnectionMenuTarget,
    action: ConnectionAction,
    value?: string,
  ) {
    const config = target.config;
    if (connectionActionsPending.current.has(config.id)) return;
    connectionActionsPending.current.add(config.id);
    try {
      if (action === "new") {
        setModal(true);
        return;
      }
      if (action === "star") {
        patchAppearance(config.id, {
          starred: !appearance[config.id]?.starred,
        });
        return;
      }
      if (action === "color") {
        patchAppearance(config.id, { color: value || undefined });
        return;
      }
      if (action === "group") {
        patchAppearance(config.id, { group: value?.trim().slice(0, 60) || "" });
        return;
      }
      if (action === "new-group") {
        setConnectionActionDialog({
          mode: "group",
          session: { id: target.sessionId ?? config.id, config },
        });
        return;
      }
      if (action === "edit" || action === "duplicate") {
        const savedProfiles =
          action === "edit" && api.desktop
            ? await api.listProfiles()
            : profiles;
        if (action === "edit") setProfiles(savedProfiles);
        setConnectionEditor({
          mode: action,
          original: config,
          sessionId: target.sessionId,
          config:
            action === "duplicate"
              ? duplicateConnection(config)
              : {
                  ...config,
                  password: savedProfiles.some((p) => p.id === config.id)
                    ? undefined
                    : "",
                },
        });
        return;
      }
      if (action === "close") {
        if (target.sessionId) await closeConnection(target.sessionId);
        return;
      }
      if (action === "delete") {
        if (
          !(await confirmAction({
            title: `Delete connection ${config.name}?`,
            body: "Remove this saved profile and close its connection. Database files, tables and records are kept.",
            confirmLabel: "Delete Connection",
            details: [config.name],
          }))
        )
          return;
        if (target.sessionId && !(await closeConnection(target.sessionId)))
          return;
        if (profiles.some((p) => p.id === config.id)) {
          await api.deleteProfile(config.id);
          setProfiles(await api.listProfiles());
        }
        setAppearance((current) => {
          const next = { ...current };
          delete next[config.id];
          return next;
        });
        setNotice(`Connection ${config.name} deleted.`, "success");
        return;
      }
      if (action === "share") {
        setDatabaseUtility({
          mode: "share",
          connection: true,
          session: { id: target.sessionId ?? config.id, config },
          database: config.database,
        });
        return;
      }
      if (action === "switch") {
        const profile = profiles.find((p) => p.id === value);
        if (!profile) throw new Error("Saved profile is no longer available.");
        if (profile.id === config.id) return;
        if (
          target.sessionId &&
          !(await prepareConnectionClose(
            target.sessionId,
            "Switching the connection profile",
          ))
        )
          return;
        let id: string | undefined;
        try {
          id = await api.connect(profile);
          if (target.sessionId && id !== target.sessionId) {
            await api.disconnect(target.sessionId);
            w.removeSession(target.sessionId);
          }
          connected(id, profile);
          setNotice(
            `Switched to connection profile ${profile.name}.`,
            "success",
          );
        } catch (cause) {
          if (id && !useWorkspace.getState().sessions.some((s) => s.id === id))
            await api.disconnect(id).catch(() => {});
          throw cause;
        }
        return;
      }
      const current = await activeConnection(target);
      if (action === "open") return;
      if (action === "query") {
        w.addTab(
          current.id,
          undefined,
          "Query",
          current.config.database || current.databases?.[0],
        );
        return;
      }
      if (action === "new-database") {
        setDatabaseDialog({
          session: current,
          database: current.config.database,
          mode: "create",
        });
        return;
      }
      if (action === "execute-file") {
        const databases =
          current.databases ?? (await api.listDatabases(current.id));
        setConnectionActionDialog({
          mode: "execute-file",
          session: { ...current, databases },
        });
        return;
      }
      if (action === "flush") {
        const sql = flushCommands[value as keyof typeof flushCommands];
        if (current.config.driver !== "mysql" || !sql)
          throw new Error("Flush is available only for MySQL/MariaDB.");
        setNotice(`Flushing ${value?.toLowerCase()}…`, "info");
        await api.execute(
          current.id,
          sql,
          current.config.database || undefined,
        );
        setNotice(`Flush ${value?.toLowerCase()} completed.`, "success");
        return;
      }
      if (action === "refresh") {
        w.updateSession(current.id, {
          trees: {},
          explorerVersion: (current.explorerVersion ?? 0) + 1,
        });
        await refresh(current.id);
      }
    } catch (cause) {
      setNotice(String(cause));
    } finally {
      connectionActionsPending.current.delete(config.id);
    }
  }
  async function openSaved(config: ConnectionConfig) {
    if (pending.current.has(config.id)) return;
    pending.current.add(config.id);
    try {
      const id = await api.connect(config);
      connected(id, config);
    } catch (e) {
      setNotice(String(e));
    } finally {
      pending.current.delete(config.id);
    }
  }
  async function removeSaved(config: ConnectionConfig) {
    try {
      await api.deleteProfile(config.id);
      setProfiles(await api.listProfiles());
    } catch (e) {
      setNotice(String(e));
    }
  }
  async function runTableView(
    id: string,
    connectionId: string,
    database: string,
    table: TableInfo,
    page = 1,
    pageSize = 1000,
    filters: TableFilter[] = [],
    sort?: TableSort,
    quick?: boolean,
  ) {
    if (pending.current.has(id)) return;
    pending.current.add(id);
    w.updateTab(id, { running: true, error: undefined });
    try {
      const result = await api.viewTable(
        connectionId,
        database,
        table,
        page,
        pageSize,
        filters,
        sort,
        quick ??
          useWorkspace.getState().tabs.find((t) => t.id === id)?.result?.source
            ?.quick ??
          false,
      );
      const state = useWorkspace.getState();
      const driver =
        state.sessions.find((s) => s.id === connectionId)?.config.driver ??
        "sqlite";
      state.updateTab(id, {
        result,
        query: tableQuery(
          table,
          driver,
          result.pagination?.page_size ?? pageSize,
          result.pagination?.page ?? page,
          result.source?.primary_keys,
          result.source?.filters,
          result.source?.sort,
        ),
      });
    } catch (e) {
      if (useWorkspace.getState().tabs.find((t) => t.id === id)?.result?.source)
        setNotice(`Could not load this table page: ${String(e)}`);
      else
        useWorkspace
          .getState()
          .updateTab(id, { error: String(e), result: undefined });
    } finally {
      pending.current.delete(id);
      useWorkspace.getState().updateTab(id, { running: false });
    }
  }
  const openTable = async (
    s: Session,
    t: TableInfo,
    database: string,
    quick = false,
  ) => {
    const existing = useWorkspace
      .getState()
      .tabs.find(
        (tab) =>
          tab.connectionId === s.id &&
          tab.tableIdentity?.database === database &&
          tab.tableIdentity?.schema === t.schema &&
          tab.tableIdentity?.name === t.name,
      );
    if (existing) {
      w.setActive(existing.id);
      if (!!existing.result?.source?.quick !== quick) {
        if (!(await confirmDiscardStaged([existing], "Switching table mode")))
          return;
        w.updateTab(existing.id, { staged: undefined });
        await runTableView(
          existing.id,
          s.id,
          database,
          t,
          1,
          existing.result?.pagination?.page_size ?? 1000,
          [],
          undefined,
          quick,
        );
      }
      if (window.innerWidth <= 520) setExplorerOpen(false);
      return;
    }
    const query = tableQuery(t, s.config.driver);
    w.addTab(s.id, query, t.name, database);
    const id = useWorkspace.getState().activeTab;
    w.updateTab(id, {
      editorOpen: false,
      tableIdentity: { database, schema: t.schema, name: t.name },
    });
    if (window.innerWidth <= 520) setExplorerOpen(false);
    void runTableView(id, s.id, database, t, 1, 1000, [], undefined, quick);
  };
  async function deleteSelectedRows(selectedRows: unknown[][]) {
    if (!tab?.result?.source || tab.running || pending.current.has(tab.id))
      throw new Error("Wait for the current operation to finish.");
    const currentTab = tab;
    const result = tab.result;
    const source = result.source!;
    const keys = rowKeys(result, selectedRows);
    pending.current.add(currentTab.id);
    w.updateTab(currentTab.id, { running: true });
    try {
      const deleted = await api.deleteRows(
        currentTab.connectionId,
        source,
        keys,
      );
      const removed = new Set(selectedRows);
      useWorkspace.getState().updateTab(currentTab.id, {
        result: {
          ...result,
          rows: result.rows.filter((row) => !removed.has(row)),
        },
      });
      try {
        const refreshed = await api.viewTable(
          currentTab.connectionId,
          source.database,
          source.table,
          result.pagination?.page ?? 1,
          result.pagination?.page_size ?? 1000,
          source.filters ?? [],
          source.sort,
        );
        const state = useWorkspace.getState();
        const driver =
          state.sessions.find((s) => s.id === currentTab.connectionId)?.config
            .driver ?? "sqlite";
        state.updateTab(currentTab.id, {
          result: refreshed,
          query: tableQuery(
            source.table,
            driver,
            refreshed.pagination?.page_size ?? 1000,
            refreshed.pagination?.page ?? 1,
            refreshed.source?.primary_keys,
            refreshed.source?.filters,
            refreshed.source?.sort,
          ),
        });
      } catch (error) {
        setNotice(
          `${deleted} rows deleted. Could not refresh the table: ${String(error)}`,
        );
      }
    } finally {
      pending.current.delete(currentTab.id);
      useWorkspace.getState().updateTab(currentTab.id, { running: false });
    }
  }
  async function writeRecord(
    action: (current: QueryTab, source: TableSource) => Promise<number>,
    goToLastPage = false,
  ) {
    if (!tab?.result?.source || tab.running || pending.current.has(tab.id))
      throw new Error("Wait for the current operation to finish.");
    const current = tab;
    const source = current.result!.source!;
    pending.current.add(current.id);
    w.updateTab(current.id, { running: true });
    try {
      const changed = await action(current, source);
      const pageSize = current.result!.pagination?.page_size ?? 1000;
      const page =
        goToLastPage && !source.sort && !source.filters?.length
          ? Math.max(
              1,
              Math.ceil(
                ((current.result!.pagination?.total_rows ??
                  current.result!.rows.length) +
                  changed) / // Every inserted record, so a batch lands in view.
                  pageSize,
              ),
            )
          : (current.result!.pagination?.page ?? 1);
      try {
        const refreshed = await api.viewTable(
          current.connectionId,
          source.database,
          source.table,
          page,
          pageSize,
          source.filters ?? [],
          source.sort,
        );
        const state = useWorkspace.getState();
        const driver =
          state.sessions.find((s) => s.id === current.connectionId)?.config
            .driver ?? "sqlite";
        state.updateTab(current.id, {
          result: refreshed,
          query: tableQuery(
            source.table,
            driver,
            refreshed.pagination?.page_size ?? 1000,
            refreshed.pagination?.page ?? 1,
            refreshed.source?.primary_keys,
            refreshed.source?.filters,
            refreshed.source?.sort,
          ),
        });
      } catch (error) {
        setNotice(
          `Record saved. Could not refresh the table: ${String(error)}`,
        );
      }
      return changed;
    } finally {
      pending.current.delete(current.id);
      useWorkspace.getState().updateTab(current.id, { running: false });
    }
  }

  return (
    <div
      className={`app ${tab ? "has-workspace" : ""} ${!explorerOpen ? "explorer-hidden" : ""} ${tableFocus ? "table-focused" : ""} ${detached ? "detached-window" : ""}`}
      onContextMenu={(event) => {
        if (event.defaultPrevented) {
          setAreaMenu(null);
          return;
        }
        event.preventDefault();
        const target = event.target as HTMLElement;
        if (
          target.closest(
            ".monaco-editor, .monaco-menu-container, [role='menu']",
          )
        )
          return;
        const input = target.closest<HTMLInputElement | HTMLTextAreaElement>(
          "input, textarea",
        );
        if (input) {
          if (input.selectionStart === null) return;
          setAreaMenu({
            x: event.clientX,
            y: event.clientY,
            trigger: input,
            label: "Text editing actions",
            items: textContextItems(input, (message) => setNotice(message)),
          });
          return;
        }
        // Modal controls own their actions; never offer unrelated workspace commands.
        if (target.closest(".modal-backdrop")) return;
        const sidebar = !!target.closest(
          ".sidebar-scroll, .sidebar-heading, .sidebar-bottom",
        );
        setAreaMenu({
          x: event.clientX,
          y: event.clientY,
          trigger:
            target.closest<HTMLElement>("button, [tabindex]") ??
            event.currentTarget,
          label: sidebar ? "Connections actions" : "Workspace actions",
          items: [
            ...(!detached
              ? [{ label: "New Connection…", action: () => setModal(true) }]
              : []),
            ...(!detached && session && !sidebar
              ? [
                  {
                    label: "New Query",
                    action: () => {
                      w.addTab(
                        session.id,
                        undefined,
                        "Query",
                        tab?.database ?? session.config.database,
                      );
                    },
                  },
                ]
              : []),
            { label: "Help and shortcuts", action: () => setHelp(true) },
          ],
        });
      }}
      onKeyDownCapture={(event) => {
        const target = event.target as HTMLElement;
        const action = editorSearchFromKey(event);
        if (!tab?.result || !action) return;
        if (
          target.closest(
            ".results, .monaco-editor, aside, [role='dialog'], .modal, [role='menu'], input, textarea, select, [contenteditable='true']",
          )
        )
          return;
        const search = event.currentTarget.querySelector<HTMLButtonElement>(
          action === "replace"
            ? ".results [data-grid-replace-trigger]"
            : ".results [data-grid-find-trigger]",
        );
        if (!search || search.disabled) return;
        event.preventDefault();
        event.stopPropagation();
        search.click();
      }}
      onKeyDown={(event) => {
        if (
          detached &&
          tab &&
          (event.ctrlKey || event.metaKey) &&
          event.key.toLowerCase() === "w"
        ) {
          event.preventDefault();
          void tabAction(tab.id, "close");
        }
      }}
    >
      {!detached && (
        <header className="titlebar">
          {!detached && (
            <button
              className="icon-button explorer-toggle"
              aria-label={
                explorerOpen && !tableFocus ? "Hide explorer" : "Show explorer"
              }
              aria-expanded={explorerOpen && !tableFocus}
              title={
                explorerOpen && !tableFocus ? "Hide explorer" : "Show explorer"
              }
              onClick={() => {
                if (tableFocus) {
                  setTableFocus(false);
                  setExplorerOpen(true);
                } else setExplorerOpen(!explorerOpen);
              }}
            >
              {explorerOpen && !tableFocus ? (
                <PanelLeftClose size={17} />
              ) : (
                <PanelLeftOpen size={17} />
              )}
            </button>
          )}
          <div className="brand">
            <span className="brand-mark">
              <img src={appIcon} alt="" width={25} height={25} />
            </span>{" "}
            DBde <span className="brand-sub">DATABASE DESKTOP</span>
          </div>
          <div className="title-center">
            <span className="dot" /> Local workspace
          </div>
          <div className="titlebar-actions">
            <ThemeToggle />
            <AppUpdater />
            <button
              className="icon-button"
              aria-label="Help and shortcuts"
              onClick={() => setHelp(true)}
            >
              <CircleHelp size={17} />
            </button>
          </div>
        </header>
      )}
      <div className="app-body">
        {!detached && (
          <ResizableSidebar>
            <div className="sidebar-heading">
              <span>EXPLORER</span>
              <button
                className="icon-button"
                title="New connection"
                aria-label="New connection"
                onClick={() => setModal(true)}
                disabled={!api.desktop}
              >
                <Plus size={16} />
              </button>
            </div>
            <label className="search">
              <Search size={14} />
              <input
                value={search}
                onChange={(e) => setSearch(e.target.value)}
                placeholder="Find database or table…"
                aria-label="Find database or table"
              />
              {search ? (
                <button
                  className="icon-button"
                  aria-label="Clear sidebar search"
                  onClick={() => setSearch("")}
                >
                  <X size={13} />
                </button>
              ) : (
                <kbd>⌕</kbd>
              )}
            </label>
            <div className="sidebar-scroll">
              {!!favorites.length && (
                <div className="tab-favorites">
                  <div className="tree-section">FAVORITES</div>
                  {favorites
                    .filter(
                      (favorite) =>
                        !searchTerm(search) ||
                        `${favorite.name} ${favorite.database}`
                          .toLowerCase()
                          .includes(searchTerm(search)),
                    )
                    .map((favorite) => (
                      <div className="table-node" key={favorite.id}>
                        <button
                          className="table-name"
                          title={`${favorite.database} / ${favorite.name}`}
                          onClick={() => void openFavorite(favorite)}
                        >
                          <Star size={13} />
                          <span>{favorite.name}</span>
                        </button>
                        <button
                          className="tiny-button"
                          aria-label={`Remove favorite ${favorite.name}`}
                          onClick={() =>
                            setFavorites((old) =>
                              old.filter((item) => item.id !== favorite.id),
                            )
                          }
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                </div>
              )}
              {!!shortcuts.length && (
                <div className="table-shortcuts">
                  <div className="tree-section">TABLE SHORTCUTS</div>
                  {shortcuts
                    .filter(
                      (x) =>
                        !searchTerm(search) ||
                        x.database.toLowerCase().includes(searchTerm(search)) ||
                        x.table.name.toLowerCase().includes(searchTerm(search)),
                    )
                    .map((x) => (
                      <div
                        className="table-node"
                        key={`${x.profile_id}:${x.database}:${x.table.schema}:${x.table.name}`}
                      >
                        <button
                          className="table-name"
                          title={`${x.database}.${x.table.schema ? x.table.schema + "." : ""}${x.table.name}`}
                          onClick={() => void openShortcut(x)}
                        >
                          <Pin size={13} />
                          <span>{x.table.name}</span>
                        </button>
                        <button
                          className="tiny-button"
                          aria-label={`Unpin ${x.table.name}`}
                          onClick={() =>
                            setShortcuts((old) =>
                              old.filter((item) => item !== x),
                            )
                          }
                        >
                          <X size={12} />
                        </button>
                      </div>
                    ))}
                </div>
              )}

              {orderedSessions.map((s, index) => (
                <div className="connection-tree" key={s.id}>
                  {appearance[s.config.id]?.group &&
                    (index === 0 ||
                      appearance[orderedSessions[index - 1].config.id]
                        ?.group !== appearance[s.config.id]?.group) && (
                      <div className="connection-group-heading">
                        <FolderClosed size={12} />
                        <span>{appearance[s.config.id]?.group}</span>
                      </div>
                    )}
                  <div
                    className="connection-heading"
                    onContextMenu={(event) => {
                      event.preventDefault();
                      showConnectionMenu(
                        s.config,
                        s.id,
                        event.currentTarget.querySelector<HTMLButtonElement>(
                          "button",
                        )!,
                        event.clientX,
                        event.clientY,
                      );
                    }}
                  >
                    <button
                      onKeyDown={(event) =>
                        connectionShortcut(event, s.config, s.id)
                      }
                      aria-expanded={
                        !collapsed.includes(s.id) || !!searchTerm(search)
                      }
                      onClick={() =>
                        setCollapsed((c) =>
                          c.includes(s.id)
                            ? c.filter((id) => id !== s.id)
                            : [...c, s.id],
                        )
                      }
                    >
                      {collapsed.includes(s.id) && !searchTerm(search) ? (
                        <ChevronRight size={13} />
                      ) : (
                        <ChevronDown size={13} />
                      )}
                      <Database
                        size={15}
                        style={
                          appearance[s.config.id]?.color
                            ? { color: appearance[s.config.id].color }
                            : undefined
                        }
                      />
                      <span title={s.config.name}>{s.config.name}</span>
                      {appearance[s.config.id]?.starred && (
                        <Star
                          size={12}
                          className="connection-star"
                          fill="currentColor"
                          aria-label="Starred connection"
                        />
                      )}
                      <span className="dot" />
                    </button>
                    <button
                      className="icon-button connection-menu-button"
                      aria-label={`Actions for connection ${s.config.name}`}
                      aria-haspopup="menu"
                      onClick={(event) =>
                        showConnectionMenu(s.config, s.id, event.currentTarget)
                      }
                    >
                      <MoreHorizontal size={13} />
                    </button>
                    <button
                      className="icon-button"
                      aria-label={`Disconnect ${s.config.name}`}
                      onClick={() => void closeConnection(s.id)}
                    >
                      <Unplug size={13} />
                    </button>
                  </div>
                  {(!collapsed.includes(s.id) || !!searchTerm(search)) && (
                    <>
                      <div className="tree-section database-section-heading">
                        <span className="tree-section-label">Databases</span>
                        <span className="tree-count">
                          {s.databases?.length ?? "—"}
                        </span>
                        <button
                          className="icon-button"
                          aria-label={`Refresh databases for ${s.config.name}`}
                          onClick={() => void refresh(s.id)}
                        >
                          <RefreshCw
                            size={12}
                            className={s.loading ? "spin" : ""}
                          />
                        </button>
                      </div>
                      {s.error && <div className="tree-error">{s.error}</div>}
                      {s.loading && !s.databases && (
                        <div className="empty-inline">Loading databases…</div>
                      )}
                      {s.databases?.map((database) => (
                        <ExplorerDatabase
                          key={database}
                          session={s}
                          database={database}
                          search={search}
                          reveal={reveal}
                          onBrowse={() => {
                            w.openDatabaseTab(s.id, database);
                            if (window.innerWidth <= 520)
                              setExplorerOpen(false);
                          }}
                          onDatabaseAction={(action) =>
                            databaseAction(s, database, action)
                          }
                          onOpen={(t) => openTable(s, t, database)}
                          onAction={(t, action) =>
                            void tableAction(s, database, t, action)
                          }
                          onMaintain={(t, operation) =>
                            void maintainTables(s, database, [t], operation)
                          }
                          onQuery={() =>
                            w.addTab(
                              s.id,
                              undefined,
                              `Query · ${database}`,
                              database,
                            )
                          }
                        >
                          <ExplorerObjects
                            session={s}
                            database={database}
                            search={searchTerm(search)}
                            onAction={(object, action) =>
                              void objectAction(s, database, object, action)
                            }
                            onNew={(kind) => newObject(s, database, kind)}
                          />
                          <ExplorerQueries
                            database={database}
                            queries={library.savedQueries.filter(
                              (query) =>
                                query.profile_id === s.config.id &&
                                query.database === database,
                            )}
                            search={searchTerm(search)}
                            onOpen={(query) => void openSavedQuery(query)}
                            onManage={() => setLibraryPanel("queries")}
                          />
                        </ExplorerDatabase>
                      ))}
                      {!!searchTerm(search) &&
                        !!s.databases?.length &&
                        s.databases.every(
                          (database) =>
                            s.trees?.[database] &&
                            !database
                              .toLowerCase()
                              .includes(searchTerm(search)) &&
                            !matchingTables(
                              database,
                              s.trees[database].tables,
                              search,
                            ).length,
                        ) && (
                          <div className="empty-inline" role="status">
                            No matching databases or tables.
                          </div>
                        )}
                      {s.databases?.length === 0 && (
                        <div className="empty-inline">
                          No accessible databases.
                        </div>
                      )}
                    </>
                  )}
                </div>
              ))}
              {!w.sessions.length && (
                <div className="sidebar-empty">
                  <Database size={25} />
                  <p>
                    Your databases,
                    <br />
                    all in one place.
                  </p>
                </div>
              )}
              {profiles.length > 0 && (
                <>
                  <div className="saved-heading">SAVED CONNECTIONS</div>
                  {profiles.map((p) => (
                    <div
                      className="saved-row"
                      key={p.id}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        showConnectionMenu(
                          p,
                          w.sessions.find((s) => s.config.id === p.id)?.id,
                          event.currentTarget.querySelector<HTMLButtonElement>(
                            "button",
                          )!,
                          event.clientX,
                          event.clientY,
                        );
                      }}
                    >
                      <button
                        onClick={() => void openSaved(p)}
                        onKeyDown={(event) =>
                          connectionShortcut(
                            event,
                            p,
                            w.sessions.find((s) => s.config.id === p.id)?.id,
                          )
                        }
                      >
                        <Database
                          size={14}
                          style={
                            appearance[p.id]?.color
                              ? { color: appearance[p.id].color }
                              : undefined
                          }
                        />
                        {p.name}
                        {appearance[p.id]?.starred && (
                          <Star
                            size={11}
                            className="connection-star"
                            fill="currentColor"
                          />
                        )}
                      </button>
                      <button
                        className="icon-button"
                        title="Remove saved profile"
                        aria-label={`Remove ${p.name}`}
                        onClick={() => void removeSaved(p)}
                      >
                        <Trash2 size={12} />
                      </button>
                    </div>
                  ))}
                </>
              )}
            </div>
            <div className="sidebar-bottom">
              <span className="local-icon">
                <ShieldIcon />
              </span>
              <div>
                Local first. Always.<small>Your data stays yours.</small>
              </div>
            </div>
          </ResizableSidebar>
        )}
        <main className="workspace">
          <div className="workspace-top">
            <div>
              <span className="eyebrow">
                {tab
                  ? `${session?.config.name ?? "Workspace"}${tab.database ? " / " + tab.database : ""}`
                  : "WORKSPACE"}
              </span>
              <h1>
                {tab
                  ? (tab.result?.source?.table.name ?? tab.name)
                  : (session?.config.name ?? "A clearer view of your data")}
                <span className="version">
                  {session
                    ? session.config.driver === "postgres"
                      ? "PostgreSQL"
                      : session.config.driver === "mysql"
                        ? "MySQL"
                        : "SQLite"
                    : "v0.1.0"}
                </span>
              </h1>
            </div>
            {!detached && (
              <div className="workspace-top-actions">
                <button
                  className="icon-button"
                  aria-label="Database tools"
                  title="Database Tools: transfer, monitor, object information, query builder and ER model"
                  disabled={!session}
                  onClick={() => setDatabaseToolsOpen(true)}
                >
                  <Layers size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Query history"
                  title={`Query history (${libraryShortcutLabel("history")})`}
                  onClick={() => setLibraryPanel("history")}
                >
                  <History size={16} />
                </button>
                <button
                  className="icon-button"
                  aria-label="Saved queries"
                  title={`Saved queries (${libraryShortcutLabel("queries")})`}
                  onClick={() => setLibraryPanel("queries")}
                >
                  <BookMarked size={16} />
                </button>
              </div>
            )}
            {!detached && (
              <button
                className="button secondary"
                onClick={() =>
                  session &&
                  w.addTab(
                    session.id,
                    undefined,
                    `Query ${w.tabs.length + 1}`,
                    tab?.database ?? session.databases?.[0],
                  )
                }
                disabled={!session}
              >
                <Plus size={15} /> New query
              </button>
            )}
          </div>
          {!api.desktop && (
            <div className="demo-banner">
              <span className="dot amber" />
              <span>
                Browser sandbox{" "}
                <span className="muted">
                  · In-memory SQLite. Changes reset on reload.
                </span>
              </span>
              <button
                onClick={() =>
                  w.sessions.length ? setHelp(true) : void openDemo()
                }
              >
                {w.sessions.length ? "About desktop" : "Try the sandbox"}
                <ArrowUpRight size={13} />
              </button>
            </div>
          )}
          {notice && (
            <div
              {...noticeDismiss}
              className={`notice ${noticeState.tone}`}
              role={noticeState.tone === "error" ? "alert" : "status"}
            >
              {notice}
              <button
                className="icon-button"
                onClick={() => setNotice("")}
                aria-label={
                  noticeState.tone === "error"
                    ? "Dismiss error"
                    : "Dismiss notification"
                }
              >
                <X size={14} />
              </button>
            </div>
          )}
          {tab ? (
            <>
              {!detached && (
                <div
                  className="tabs"
                  role="tablist"
                  aria-label="Workspace tabs"
                  ref={tabDrag.strip}
                  onClickCapture={tabDrag.click}
                >
                  {w.tabs.map((t) => (
                    <div
                      className={`tab ${w.activeTab === t.id ? "active" : ""}`}
                      key={t.id}
                      data-tab-id={t.id}
                      data-drop={
                        tabDrag.drop?.target === t.id &&
                        tabDrag.drop.id !== t.id
                          ? tabDrag.drop.after
                            ? "after"
                            : "before"
                          : undefined
                      }
                      data-dragging={tabDrag.draggedId === t.id || undefined}
                      onPointerDown={(event) => {
                        if (!t.running) tabDrag.begin(event, t.id);
                      }}
                      onAuxClick={(event) => {
                        if (event.button === 1) {
                          event.preventDefault();
                          void tabAction(t.id, "close");
                        }
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        w.setActive(t.id);
                        setTabMenu({
                          id: t.id,
                          x: event.clientX,
                          y: event.clientY,
                          trigger:
                            event.currentTarget.querySelector<HTMLElement>(
                              "[role=tab]",
                            )!,
                        });
                      }}
                    >
                      <button
                        role="tab"
                        aria-selected={w.activeTab === t.id}
                        tabIndex={w.activeTab === t.id ? 0 : -1}
                        title={`${t.name}${t.database ? " · " + t.database : ""}`}
                        onClick={() => w.setActive(t.id)}
                        onKeyDown={(event) => {
                          if (
                            event.key === "ContextMenu" ||
                            (event.shiftKey && event.key === "F10")
                          ) {
                            event.preventDefault();
                            const rect =
                              event.currentTarget.getBoundingClientRect();
                            setTabMenu({
                              id: t.id,
                              x: rect.left,
                              y: rect.bottom,
                              trigger: event.currentTarget,
                            });
                            return;
                          }
                          if (
                            (event.ctrlKey || event.metaKey) &&
                            event.key.toLowerCase() === "w"
                          ) {
                            event.preventDefault();
                            void tabAction(t.id, "close");
                            return;
                          }
                          if (
                            ![
                              "ArrowLeft",
                              "ArrowRight",
                              "Home",
                              "End",
                            ].includes(event.key)
                          )
                            return;
                          event.preventDefault();
                          const index = w.tabs.findIndex(
                            (tab) => tab.id === t.id,
                          );
                          const next =
                            event.key === "Home"
                              ? 0
                              : event.key === "End"
                                ? w.tabs.length - 1
                                : (index +
                                    (event.key === "ArrowRight" ? 1 : -1) +
                                    w.tabs.length) %
                                  w.tabs.length;
                          w.setActive(w.tabs[next].id);
                          event.currentTarget
                            .closest(".tabs")
                            ?.querySelectorAll<HTMLButtonElement>("[role=tab]")
                            [next]?.focus();
                        }}
                        onDoubleClick={() => {
                          const name = window.prompt("Query tab name", t.name);
                          if (name?.trim())
                            w.updateTab(t.id, { name: name.trim() });
                        }}
                      >
                        {t.kind === "database" ? (
                          <Database size={14} />
                        ) : t.tableIdentity || t.result?.source ? (
                          <Table2 size={14} />
                        ) : (
                          <FileCode2 size={14} />
                        )}
                        {t.name}
                        {t.staged && pendingCount(t.staged) > 0 && (
                          <span
                            className="tab-dirty"
                            title="Unsaved record changes"
                            aria-label="Unsaved changes"
                          />
                        )}
                        {tabHasUnsavedQuery(t) && (
                          <span
                            className="tab-dirty query-dirty"
                            title="Unsaved query changes"
                            aria-label="Unsaved query changes"
                          />
                        )}
                        {t.running && <Loader2 size={12} className="spin" />}
                      </button>
                      <button
                        className="tab-close"
                        aria-label={`Close ${t.name}`}
                        onClick={() => void closeQueryTab(t)}
                        disabled={t.running}
                      >
                        <X size={12} />
                      </button>
                    </div>
                  ))}
                  {!detached && (
                    <button
                      className="icon-button"
                      aria-label="New query tab"
                      onClick={() =>
                        session &&
                        w.addTab(
                          session.id,
                          undefined,
                          undefined,
                          tab?.database ?? session.databases?.[0],
                        )
                      }
                    >
                      <Plus size={15} />
                    </button>
                  )}
                </div>
              )}
              {tab.kind === "database" && session && tab.database ? (
                <DatabaseTables
                  key={tab.id}
                  session={session}
                  database={tab.database}
                  loadSchema={explorerSchema}
                  onTool={(pane) => {
                    setDatabaseToolsPane(pane);
                    setDatabaseToolsOpen(true);
                  }}
                  onQuery={() =>
                    w.addTab(session.id, undefined, "Query", tab.database!)
                  }
                  canPaste={!!tableClipboard}
                  onCopy={(tables) =>
                    void copyTables(session, tab.database!, tables)
                  }
                  onPaste={(text) =>
                    void pasteTables(session, tab.database!, text)
                  }
                  onAction={(table, action) =>
                    void tableAction(session, tab.database!, table, action)
                  }
                  onMaintain={(tables, operation) =>
                    void maintainTables(
                      session,
                      tab.database!,
                      tables,
                      operation,
                    )
                  }
                  onOpen={(table) =>
                    void openTable(session, table, tab.database!)
                  }
                  onCreate={() =>
                    void databaseAction(session, tab.database!, "new-table")
                  }
                />
              ) : (
                <>
                  <div
                    className="editor-toolbar"
                    role={detached ? "toolbar" : undefined}
                    aria-label={detached ? "Focused table actions" : undefined}
                    tabIndex={detached ? 0 : undefined}
                    onContextMenu={(event) => {
                      if (!detached) return;
                      event.preventDefault();
                      setTabMenu({
                        id: tab.id,
                        x: event.clientX,
                        y: event.clientY,
                        trigger: event.currentTarget,
                      });
                    }}
                    onKeyDown={(event) => {
                      if (
                        !detached ||
                        !(
                          event.key === "ContextMenu" ||
                          (event.shiftKey && event.key === "F10")
                        )
                      )
                        return;
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setTabMenu({
                        id: tab.id,
                        x: rect.left + 8,
                        y: rect.bottom,
                        trigger: event.currentTarget,
                      });
                    }}
                  >
                    {detached && <ThemeToggle />}
                    {detached && (
                      <span
                        className="detached-table-context"
                        title={`${session?.config.name ?? ""} / ${tab.database ?? ""} / ${tab.result?.source?.table.name ?? tab.name}`}
                      >
                        <Table2 size={14} />
                        <strong>
                          {tab.result?.source?.table.name ?? tab.name}
                        </strong>
                        <span>
                          {session?.config.name}
                          {tab.database ? ` / ${tab.database}` : ""}
                        </span>
                      </span>
                    )}
                    {!detached && (
                      <>
                        <span className="workspace-kind">
                          <Table2 size={14} />
                          {tab.result?.source ? "Table data" : "SQL workspace"}
                        </span>
                        <span className="editor-connection">
                          <span className="dot" />
                          <select
                            aria-label="Query database"
                            value={tab.database ?? ""}
                            disabled={
                              detached ||
                              tab.running ||
                              !session?.databases?.length
                            }
                            onChange={(e) =>
                              void changeDatabase(tab, e.target.value)
                            }
                          >
                            {!tab.database && (
                              <option value="">Choose database</option>
                            )}
                            {session?.databases?.map((database) => (
                              <option key={database} value={database}>
                                {database}
                              </option>
                            ))}
                          </select>
                        </span>
                      </>
                    )}
                    <span className="spacer" />
                    <div
                      className="toolbar-group workspace-view-tools"
                      role="group"
                      aria-label="Workspace view"
                    >
                      {detached &&
                        !tab.result?.source &&
                        !tab.tableIdentity && (
                          <button
                            className="button subtle"
                            disabled={tab.running}
                            onClick={() => void run()}
                          >
                            <RefreshCw
                              size={14}
                              className={tab.running ? "spin" : ""}
                            />
                            {tab.result ? "Refresh results" : "Run query"}
                          </button>
                        )}
                      {tab.result?.source && (
                        <button
                          className="button subtle"
                          aria-label="Refresh table data"
                          disabled={tab.running}
                          onClick={async () => {
                            if (
                              !(await confirmDiscardStaged([tab], "Refreshing"))
                            )
                              return;
                            w.updateTab(tab.id, { staged: undefined });
                            const source = tab.result!.source!;
                            void runTableView(
                              tab.id,
                              tab.connectionId,
                              source.database,
                              source.table,
                              tab.result?.pagination?.page ?? 1,
                              tab.result?.pagination?.page_size ?? 1000,
                              source.filters ?? [],
                              source.sort,
                            );
                          }}
                        >
                          <RefreshCw
                            size={14}
                            className={tab.running ? "spin" : ""}
                          />{" "}
                          Refresh
                        </button>
                      )}
                      {!detached && (
                        <>
                          <button
                            className={`button view-toggle ${editorOpen ? "active" : ""}`}
                            aria-label={
                              editorOpen ? "Hide SQL editor" : "Show SQL editor"
                            }
                            aria-pressed={editorOpen}
                            aria-controls="sql-editor-panel"
                            onClick={() => {
                              setTableFocus(false);
                              w.updateTab(tab.id, { editorOpen: !editorOpen });
                            }}
                          >
                            <Code2 size={14} />
                            <span>SQL editor</span>
                            {editorOpen ? (
                              <ChevronDown size={12} />
                            ) : (
                              <ChevronRight size={12} />
                            )}
                          </button>
                          <button
                            className={`button view-toggle ${tableFocus ? "active" : ""}`}
                            aria-label={
                              tableFocus ? "Exit table focus" : "Focus table"
                            }
                            aria-pressed={tableFocus}
                            disabled={!tab.result}
                            onClick={() => setTableFocus(!tableFocus)}
                          >
                            {tableFocus ? (
                              <Minimize2 size={14} />
                            ) : (
                              <Maximize2 size={14} />
                            )}
                            <span>
                              {tableFocus ? "Exit focus" : "Focus table"}
                            </span>
                          </button>
                        </>
                      )}
                    </div>
                    {editorOpen && (
                      <>
                        <div
                          className="toolbar-group"
                          role="group"
                          aria-label="SQL editing"
                        >
                          {(["find", "replace"] as const).map((action) => (
                            <button
                              key={action}
                              className="icon-button"
                              aria-label={
                                action === "find"
                                  ? "Find in SQL"
                                  : "Find and replace in SQL"
                              }
                              title={`${action === "find" ? "Find in SQL" : "Find and replace in SQL"} (${editorSearchShortcut(action)})`}
                              onClick={() =>
                                void openEditorSearch(editor.current, action)
                              }
                            >
                              {action === "find" ? (
                                <Search size={15} />
                              ) : (
                                <Replace size={15} />
                              )}
                            </button>
                          ))}
                          {!detached && (
                            <>
                              <button
                                className="icon-button"
                                aria-label="Save query"
                                title={`Save query (${navigator.platform.includes("Mac") ? "⌘S" : "Ctrl+S"})`}
                                disabled={!session}
                                onClick={() =>
                                  void saveTabQuery(tab.id, "save")
                                }
                              >
                                <Save size={15} />
                              </button>
                              <button
                                className="button subtle"
                                title={`Save query as (${navigator.platform.includes("Mac") ? "⇧⌘S" : "Ctrl+Shift+S"})`}
                                disabled={!session}
                                onClick={() =>
                                  void saveTabQuery(tab.id, "saveAs")
                                }
                              >
                                Save as…
                              </button>
                              <button
                                className="icon-button"
                                aria-label="Code snippets"
                                title="Code snippets"
                                onClick={() => setLibraryPanel("snippets")}
                              >
                                <Braces size={15} />
                              </button>
                            </>
                          )}
                          <button
                            className="button subtle"
                            title="Format SQL"
                            onClick={async () => {
                              try {
                                const { format } =
                                  await import("sql-formatter");
                                w.updateTab(tab.id, {
                                  query: format(tab.query, {
                                    language:
                                      session?.config.driver === "postgres"
                                        ? "postgresql"
                                        : session?.config.driver === "mysql"
                                          ? "mysql"
                                          : "sqlite",
                                  }),
                                });
                              } catch (e) {
                                setNotice(String(e));
                              }
                            }}
                          >
                            <Wand2 size={14} /> Format
                          </button>
                        </div>
                        <div
                          className="toolbar-group query-execution"
                          role="group"
                          aria-label="Query execution"
                        >
                          <button
                            className="button subtle"
                            title={`Explain the selected statement or the one under the cursor (${navigator.platform.includes("Mac") ? "⇧⌘E" : "Ctrl+Shift+E"})`}
                            disabled={tab.running || !session}
                            onClick={() => void explainQuery()}
                          >
                            <ListTree size={14} /> Explain
                          </button>
                          <label
                            className="explain-analyze"
                            title={
                              session?.config.driver === "sqlite"
                                ? "SQLite has no EXPLAIN ANALYZE"
                                : "Run the statement to measure actual rows and time. PostgreSQL rolls writes back; MySQL/MariaDB analyzes SELECT only."
                            }
                          >
                            <input
                              type="checkbox"
                              checked={
                                !!tab.explainAnalyze &&
                                session?.config.driver !== "sqlite"
                              }
                              disabled={
                                tab.running ||
                                session?.config.driver === "sqlite"
                              }
                              onChange={(event) =>
                                w.updateTab(tab.id, {
                                  explainAnalyze: event.target.checked,
                                })
                              }
                            />
                            Analyze
                          </label>
                          {api.desktop && (
                            <select
                              className="timeout-select"
                              aria-label="Query timeout"
                              title="Query timeout. Timed-out queries are cancelled on the server."
                              value={tab.timeoutSecs ?? 30}
                              disabled={tab.running}
                              onChange={(e) =>
                                w.updateTab(tab.id, {
                                  timeoutSecs: Number(e.target.value),
                                })
                              }
                            >
                              {QUERY_TIMEOUTS.map(([seconds, label]) => (
                                <option key={seconds} value={seconds}>
                                  Timeout {label}
                                </option>
                              ))}
                            </select>
                          )}
                          {tab.running && tab.cancellable && (
                            <button
                              className="button subtle"
                              aria-label="Cancel running query"
                              onClick={() => {
                                cancelRequested.current.add(tab.id);
                                void api
                                  .cancelQuery(tab.connectionId, tab.id)
                                  .catch((e) => setNotice(String(e)));
                              }}
                            >
                              <Square size={10} fill="currentColor" /> Cancel
                            </button>
                          )}
                          <button
                            className="button primary run"
                            onClick={() => void run()}
                            disabled={tab.running}
                          >
                            {tab.running ? (
                              <Loader2 size={13} className="spin" />
                            ) : (
                              <Play size={12} fill="currentColor" />
                            )}
                            {tab.running ? "Running…" : "Run query"}
                            <kbd>
                              {navigator.platform.includes("Mac")
                                ? "⌘"
                                : "Ctrl"}{" "}
                              ↵
                            </kbd>
                          </button>
                        </div>
                      </>
                    )}
                  </div>
                  <div
                    className="editor-panel"
                    id="sql-editor-panel"
                    hidden={!editorOpen}
                  >
                    {editorOpen && (
                      <Suspense
                        fallback={
                          <div className="empty-inline">Preparing editor…</div>
                        }
                      >
                        <QueryEditor
                          key={tab.id}
                          id={tab.id}
                          value={tab.query}
                          onChange={(query) => w.updateTab(tab.id, { query })}
                          onRun={(selection) => void run(selection)}
                          onExplain={() => void explainQuery()}
                          tables={
                            session?.trees?.[tab.database ?? ""]?.tables ?? []
                          }
                          connectionId={tab.connectionId}
                          database={tab.database}
                          driver={session?.config.driver ?? "sqlite"}
                          editorRef={editor}
                          snippets={editorSnippets}
                          onSave={
                            detached
                              ? undefined
                              : () => void saveTabQuery(tab.id, "save")
                          }
                          onSaveAs={
                            detached
                              ? undefined
                              : () => void saveTabQuery(tab.id, "saveAs")
                          }
                        />
                      </Suspense>
                    )}
                  </div>
                  {editorOpen && (
                    <button
                      className="panel-divider"
                      aria-label="Collapse SQL editor"
                      title="Collapse SQL editor"
                      onClick={() => w.updateTab(tab.id, { editorOpen: false })}
                    >
                      <span />
                    </button>
                  )}
                  {tab.plan && (
                    <div
                      className="result-view-switch"
                      role="tablist"
                      aria-label="Result view"
                    >
                      <button
                        role="tab"
                        aria-selected={tab.resultView !== "plan"}
                        onClick={() =>
                          w.updateTab(tab.id, { resultView: "result" })
                        }
                      >
                        <Terminal size={12} /> Results
                      </button>
                      <button
                        role="tab"
                        aria-selected={tab.resultView === "plan"}
                        onClick={() =>
                          w.updateTab(tab.id, { resultView: "plan" })
                        }
                      >
                        <ListTree size={12} /> Plan
                      </button>
                      <button
                        className="icon-button"
                        aria-label="Close plan"
                        title="Close plan"
                        onClick={() =>
                          w.updateTab(tab.id, {
                            plan: undefined,
                            resultView: "result",
                          })
                        }
                      >
                        <X size={12} />
                      </button>
                    </div>
                  )}
                  {tab.plan && tab.resultView === "plan" ? (
                    <PlanView
                      key={`${tab.id}:${tab.plan.output.sql}:${tab.plan.output.execution_ms}`}
                      plan={tab.plan}
                      onCopy={writeClipboard}
                    />
                  ) : tab.error ? (
                    <div className="query-error" role="alert">
                      <Terminal size={23} />
                      <h3>Query could not be completed</h3>
                      <pre>{tab.error}</pre>
                    </div>
                  ) : tab.result ? (
                    <ResultGrid
                      connectionId={tab.connectionId}
                      profileId={session?.config.id}
                      key={`${tab.id}:${tab.schemaVersion ?? 0}`}
                      result={tab.result}
                      busy={tab.running}
                      onDelete={deleteSelectedRows}
                      onDesign={
                        tab.result.source && session
                          ? () =>
                              void tableAction(
                                session,
                                tab.result!.source!.database,
                                tab.result!.source!.table,
                                "structure",
                              )
                          : undefined
                      }
                      onLoadRecord={
                        tab.result.source?.quick
                          ? (row) =>
                              api.loadRecord(
                                tab.connectionId,
                                tab.result!.source!,
                                row,
                                tab.result!.columns,
                              )
                          : undefined
                      }
                      onApplyChanges={(changes) =>
                        writeRecord(
                          (current, source) =>
                            api.applyChanges(
                              current.connectionId,
                              source,
                              changes,
                            ),
                          changes.some((change) => change.kind === "insert"),
                        )
                      }
                      staged={tab.staged}
                      onStagedChange={(staged) =>
                        w.updateTab(tab.id, { staged })
                      }
                      driver={session?.config.driver ?? "sqlite"}
                      onImport={
                        session && tab.result.source
                          ? () =>
                              void tableAction(
                                session,
                                tab.result!.source!.database,
                                tab.result!.source!.table,
                                "import",
                              )
                          : undefined
                      }
                      onRefresh={() => {
                        const source = tab.result!.source!;
                        void runTableView(
                          tab.id,
                          tab.connectionId,
                          source.database,
                          source.table,
                          tab.result!.pagination?.page ?? 1,
                          tab.result!.pagination?.page_size ?? 1000,
                          source.filters ?? [],
                          source.sort,
                        );
                      }}
                      onSortChange={(sort) => {
                        const source = tab.result!.source!;
                        void runTableView(
                          tab.id,
                          tab.connectionId,
                          source.database,
                          source.table,
                          1,
                          tab.result!.pagination?.page_size ?? 1000,
                          source.filters ?? [],
                          sort,
                        );
                      }}
                      onResetView={() => {
                        const source = tab.result!.source!;
                        void runTableView(
                          tab.id,
                          tab.connectionId,
                          source.database,
                          source.table,
                          1,
                          tab.result!.pagination?.page_size ?? 1000,
                          [],
                          undefined,
                        );
                      }}
                      onProfileApply={(filters, sort) => {
                        const source = tab.result!.source!;
                        void runTableView(
                          tab.id,
                          tab.connectionId,
                          source.database,
                          source.table,
                          1,
                          tab.result!.pagination?.page_size ?? 1000,
                          filters,
                          sort,
                        );
                      }}
                      onFilterApply={(filters) => {
                        const source = tab.result!.source!;
                        void runTableView(
                          tab.id,
                          tab.connectionId,
                          source.database,
                          source.table,
                          1,
                          tab.result!.pagination?.page_size ?? 1000,
                          filters,
                          source.sort,
                        );
                      }}
                      onPageChange={(page, pageSize) => {
                        const source = tab.result!.source!;
                        void runTableView(
                          tab.id,
                          tab.connectionId,
                          source.database,
                          source.table,
                          page,
                          pageSize,
                          source.filters ?? [],
                          source.sort,
                        );
                      }}
                    />
                  ) : (
                    <div className="empty result-placeholder">
                      <Terminal size={28} />
                      <h3>
                        {tab.running ? "Loading data…" : "Ready when you are"}
                      </h3>
                      <p>
                        {tab.running
                          ? "Fetching rows from your database."
                          : "Run your query to see the results here."}
                      </p>
                      <kbd>⌘ / Ctrl + Enter</kbd>
                    </div>
                  )}
                </>
              )}
            </>
          ) : detached ? (
            <div className="empty">
              <Table2 size={26} />
              <p>No table open.</p>
            </div>
          ) : (
            <div className="welcome">
              <div className="welcome-symbol">
                <img
                  src={appIcon}
                  alt="DBde mosquito logo"
                  width={80}
                  height={80}
                />
              </div>
              <span className="eyebrow">LESS FRICTION. MORE DISCOVERY.</span>
              <h2>
                Your data.
                <br />
                <span>A little closer.</span>
              </h2>
              <p>
                A focused workspace for exploring databases,
                <br />
                writing queries, and finding what matters.
              </p>
              <button
                className="button primary"
                onClick={() => (api.desktop ? setModal(true) : void openDemo())}
              >
                <Plus size={16} />
                {api.desktop ? "Connect a database" : "Explore the sandbox"}
              </button>
              <div className="supported">
                <span>PostgreSQL</span>
                <i>·</i>
                <span>MySQL</span>
                <i>·</i>
                <span>SQLite</span>
              </div>
              <div className="welcome-features">
                <div>
                  <Layers size={18} />
                  <strong>One workspace</strong>
                  <small>All your connections together</small>
                </div>
                <div>
                  <Terminal size={18} />
                  <strong>Room to explore</strong>
                  <small>SQL editor with multiple tabs</small>
                </div>
                <div>
                  <Table2 size={18} />
                  <strong>Built for big results</strong>
                  <small>Virtualized, responsive tables</small>
                </div>
              </div>
            </div>
          )}
        </main>
      </div>
      {!detached && (
        <footer className="statusbar">
          <span>
            <span className="dot" />
            {w.sessions.length} active connection
            {w.sessions.length === 1 ? "" : "s"}
          </span>
          <span>
            {api.desktop ? "Tauri native" : "Browser sandbox"}
            <i>·</i>SQL workspace<span className="status-brand">DBde</span>
          </span>
        </footer>
      )}
      {tabMenu &&
        (() => {
          const target = w.tabs.find((tab) => tab.id === tabMenu.id);
          const current = w.sessions.find(
            (session) => session.id === target?.connectionId,
          );
          if (!target) return null;
          const blocked = (action: "close" | "others" | "right" | "all") => {
            const targets = tabsToClose(w.tabs, target.id, action);
            return !targets.length || targets.some((tab) => tab.running);
          };
          return (
            <TabContextMenu
              target={tabMenu}
              name={target.name}
              onClose={closeTabMenu}
              onAction={(action) => void tabAction(target.id, action)}
              favorite={
                !!current &&
                favorites.some(
                  (favorite) => favorite.id === favoriteFor(target, current).id,
                )
              }
              disabled={{
                close: blocked("close"),
                others: blocked("others"),
                right: blocked("right"),
                all: blocked("all"),
                move:
                  detached ||
                  target.kind === "database" ||
                  !api.desktop ||
                  !current ||
                  target.running ||
                  (current.config.driver === "sqlite" &&
                    (current.config.file_path === ":memory:" ||
                      current.config.file_path.includes("mode=memory"))),
                favorite: !current,
                reveal:
                  detached ||
                  !current ||
                  !(target.database || current.config.database),
              }}
            />
          );
        })()}
      {libraryPanel === "history" && (
        <HistoryPanel
          entries={library.history}
          enabled={library.historyOn}
          canInsert={!!tab && tab.kind !== "database"}
          onToggleEnabled={library.setHistoryOn}
          onOpen={(entry) => void openHistoryEntry(entry)}
          onInsert={(entry) => insertSql(entry.sql, false)}
          onCopy={(entry) => writeClipboard(entry.sql)}
          onDelete={(entry) => void library.deleteHistory([entry.id])}
          onClear={() => void clearAllHistory()}
          onClose={() => setLibraryPanel(null)}
        />
      )}
      {libraryPanel === "queries" && (
        <SavedQueriesPanel
          queries={library.savedQueries}
          connectionName={connectionName}
          onOpen={(query) => void openSavedQuery(query)}
          onRename={(query) =>
            setSaveDialog({
              mode: "rename",
              profileId: query.profile_id,
              database: query.database,
              initialName: query.name,
              initialDescription: query.description,
              query,
            })
          }
          onDuplicate={(query) => void duplicateQuery(query)}
          onDelete={(query) => void deleteSavedQuery(query)}
          onClose={() => setLibraryPanel(null)}
        />
      )}
      {libraryPanel === "snippets" && (
        <SnippetsPanel
          driver={session?.config.driver ?? "sqlite"}
          snippets={library.snippets}
          canInsert={!!tab && tab.kind !== "database"}
          onInsert={(snippet) => insertSql(snippet.body, true)}
          onSave={library.saveSnippet}
          onDelete={(snippet) => void deleteUserSnippet(snippet)}
          onClose={() => setLibraryPanel(null)}
        />
      )}
      {saveDialog && (
        <SaveQueryDialog
          title={
            saveDialog.mode === "rename"
              ? "Rename saved query"
              : saveDialog.mode === "saveAs"
                ? "Save query as"
                : "Save query"
          }
          submitLabel={saveDialog.mode === "rename" ? "Rename" : "Save"}
          location={`${connectionName(saveDialog.profileId)}${saveDialog.database ? ` / ${saveDialog.database}` : ""}`}
          initialName={saveDialog.initialName}
          initialDescription={saveDialog.initialDescription}
          nameError={(name) =>
            savedQueryNameError(
              name,
              library.savedQueries,
              saveDialog.profileId,
              saveDialog.database,
              saveDialog.query?.id,
            )
          }
          onSubmit={submitSaveDialog}
          onClose={() => setSaveDialog(null)}
        />
      )}
      {chooseRequest && (
        <ChooseConnectionDialog
          reason={chooseRequest.reason}
          sessions={w.sessions.map((item) => ({
            id: item.id,
            name: item.config.name,
            databases: item.databases ?? [],
          }))}
          onChoose={(id, database) => {
            chooseRequest.resolve({ id, database });
            setChooseRequest(null);
          }}
          onClose={() => {
            chooseRequest.resolve(null);
            setChooseRequest(null);
          }}
        />
      )}
      {unsavedRequest && (
        <UnsavedQueryDialog
          name={unsavedRequest.name}
          action={unsavedRequest.action}
          onResolve={unsavedRequest.resolve}
        />
      )}
      {confirmRequest && (
        <ConfirmDialog
          request={confirmRequest}
          onResolve={(confirmed) => {
            confirmRequest.resolve(confirmed);
            setConfirmRequest(null);
          }}
        />
      )}
      {connectionMenu && (
        <ConnectionContextMenu
          target={connectionMenu}
          profiles={profiles}
          groups={connectionGroups}
          appearance={appearance[connectionMenu.config.id] ?? {}}
          onClose={() => {
            if (connectionMenu.trigger.isConnected)
              connectionMenu.trigger.focus();
            setConnectionMenu(null);
          }}
          onAction={(action, value) =>
            void connectionAction(connectionMenu, action, value)
          }
        />
      )}
      {connectionEditor && (
        <ConnectionDialog
          key={`${connectionEditor.mode}:${connectionEditor.config.id}`}
          mode={connectionEditor.mode}
          initialConfig={connectionEditor.config}
          onSubmit={submitConnectionChanges}
          onConnected={connected}
          onClose={() => setConnectionEditor(null)}
        />
      )}
      {connectionActionDialog && (
        <ConnectionActionDialog
          mode={connectionActionDialog.mode}
          session={connectionActionDialog.session}
          onClose={() => setConnectionActionDialog(null)}
          onSubmit={(value) => {
            const request = connectionActionDialog;
            setConnectionActionDialog(null);
            if (request.mode === "group")
              patchAppearance(request.session.config.id, {
                group: value.slice(0, 60),
              });
            else void databaseAction(request.session, value, "execute-file");
          }}
        />
      )}
      {renameRequest && (
        <RenameTableDialog
          table={renameRequest.table}
          database={renameRequest.database}
          driver={renameRequest.session.config.driver}
          existing={
            useWorkspace
              .getState()
              .sessions.find((x) => x.id === renameRequest.session.id)?.trees?.[
              renameRequest.database
            ]?.tables ?? []
          }
          onRename={(name) => renameTableTo(renameRequest, name)}
          onClose={() => setRenameRequest(null)}
        />
      )}
      {exportRequest && (
        <ExportDialog
          request={exportRequest}
          onDone={(summary) => {
            setExportRequest(null);
            setNotice(exportSummaryText(summary), "success");
          }}
          onClose={() => setExportRequest(null)}
        />
      )}
      {importRequest && (
        <ImportDialog
          request={{
            connectionId: importRequest.session.id,
            database: importRequest.database,
            driver: importRequest.session.config.driver,
            table: importRequest.table,
          }}
          confirm={confirmAction}
          prepare={() => prepareImport(importRequest)}
          onImported={(summary) => void finishImport(importRequest, summary)}
          onClose={() => setImportRequest(null)}
        />
      )}
      {maintainResult && (
        <MaintainResultDialog
          label={maintainResult.label}
          database={maintainResult.database}
          result={maintainResult.result}
          onCopy={writeClipboard}
          onClose={() => setMaintainResult(null)}
        />
      )}
      {ddlView && (
        <DdlDialog
          table={ddlView.table}
          database={ddlView.database}
          driver={ddlView.session.config.driver}
          ddl={ddlView.ddl}
          kindLabel={ddlView.object?.kindLabel}
          note={ddlView.object ? ddlView.object.note : undefined}
          onCopy={writeClipboard}
          onSave={(ddl) =>
            api.saveFile(
              `${ddlView.object?.fileName ?? ddlView.table.name}.sql`,
              "sql",
              ddl + "\n",
            )
          }
          onOpenInEditor={(ddl) => {
            const { session, database, table } = ddlView;
            setDdlView(null);
            w.addTab(
              session.id,
              ddl + "\n",
              `DDL · ${ddlView.object?.fileName ?? table.name}`,
              database,
            );
          }}
          onClose={() => setDdlView(null)}
        />
      )}
      {sequenceReset && (
        <SequenceResetDialog
          sequence={sequenceReset.sequence}
          onSubmit={(value) => sequenceReset.resolve(value)}
          onClose={() => sequenceReset.resolve(null)}
        />
      )}
      {tableStructure && (
        <TableStructure
          key={`${tableStructure.session.id}:${tableStructure.database}:${tableStructure.table.schema}:${tableStructure.table.name}`}
          request={tableStructure}
          onClose={() => setTableStructure(null)}
          onBeforeSave={() => {
            const { session, database, table } = tableStructure;
            for (const tab of useWorkspace.getState().tabs) {
              if (
                tab.connectionId !== session.id ||
                (tab.database !== database &&
                  tab.result?.source?.database !== database)
              )
                continue;
              if (tab.running || tab.staged?.transaction)
                throw new Error(
                  "Finish running queries and commit or roll back active transactions before editing the table structure.",
                );
              const target = tab.tableIdentity ?? tab.result?.source?.table;
              if (
                target?.name === table.name &&
                target.schema === table.schema &&
                tab.staged &&
                pendingCount(tab.staged)
              )
                throw new Error(
                  "Save or discard pending record edits for this table before renaming its fields.",
                );
            }
          }}
          onSaved={(renames) => {
            const { session, database, table } = tableStructure;
            invalidateDatabase(session.id, database);
            const renamed = (name: string) =>
              renames.find((rename) => rename.from === name)?.to ?? name;
            const state = useWorkspace.getState();
            for (const tab of state.tabs) {
              const source = tab.result?.source;
              if (
                tab.connectionId !== session.id ||
                source?.database !== database ||
                source.table.name !== table.name ||
                source.table.schema !== table.schema
              )
                continue;
              state.updateTab(tab.id, {
                result: undefined,
                staged: undefined,
                error: undefined,
                schemaVersion: (tab.schemaVersion ?? 0) + 1,
              });
              void runTableView(
                tab.id,
                session.id,
                database,
                table,
                tab.result?.pagination?.page ?? 1,
                tab.result?.pagination?.page_size ?? 1000,
                source.filters?.map((filter) => ({
                  ...filter,
                  column: renamed(filter.column),
                })) ?? [],
                source.sort
                  ? { ...source.sort, column: renamed(source.sort.column) }
                  : undefined,
                source.quick,
              );
            }
          }}
          onEdit={(sql) => {
            w.addTab(
              tableStructure.session.id,
              sql,
              `Structure · ${tableStructure.table.name}`,
              tableStructure.database,
            );
            setTableStructure(null);
          }}
        />
      )}
      {tableDesigner && (
        <TableDesigner
          request={tableDesigner}
          onClose={() => setTableDesigner(null)}
          onCreated={(table) => {
            const request = tableDesigner;
            setTableDesigner(null);
            setNotice(`Table ${table.name} created.`, "success");
            void api
              .schema(request.session.id, request.database)
              .then((tree) => {
                const state = useWorkspace.getState();
                const current = state.sessions.find(
                  (s) => s.id === request.session.id,
                );
                if (current)
                  state.updateSession(current.id, {
                    trees: { ...current.trees, [request.database]: tree },
                  });
              })
              .catch((cause) =>
                setNotice(
                  `Table ${table.name} created. Refresh the sidebar: ${String(cause)}`,
                ),
              );
            void openTable(request.session, table, request.database);
          }}
        />
      )}
      {databaseDialog && (
        <DatabaseDialog
          request={databaseDialog}
          onClose={() => setDatabaseDialog(null)}
          onSubmit={saveDatabase}
        />
      )}
      {databaseUtility && (
        <DatabaseUtilityDialog
          request={databaseUtility}
          onClose={() => setDatabaseUtility(null)}
          onOpen={(table) => {
            void openTable(
              databaseUtility.session,
              table,
              databaseUtility.database,
            );
          }}
        />
      )}
      {pasteRequest && (
        <PasteTablesDialog
          source={pasteRequest.source}
          target={pasteRequest.target}
          database={pasteRequest.database}
          onClose={() => {
            invalidateDatabase(pasteRequest.target.id, pasteRequest.database);
            setPasteRequest(null);
          }}
          onDone={(count) => {
            invalidateDatabase(pasteRequest.target.id, pasteRequest.database);
            setNotice(
              `Copied ${count} table(s) to ${pasteRequest.database}.`,
              "success",
            );
            setPasteRequest(null);
          }}
        />
      )}
      {databaseToolsOpen && session && (
        <DatabaseTools
          sessions={w.sessions}
          initialSessionId={session.id}
          initialPane={databaseToolsPane}
          initialDatabase={
            tab?.database ?? session.databases?.[0] ?? session.config.database
          }
          onClose={() => setDatabaseToolsOpen(false)}
          onSQL={(id, database, sql, name) => {
            w.addTab(id, sql, name, database);
            setDatabaseToolsOpen(false);
          }}
          onChanged={() => {
            for (const item of w.sessions)
              w.updateSession(item.id, {
                explorerVersion: (item.explorerVersion ?? 0) + 1,
              });
          }}
        />
      )}
      {tableTool && (
        <TableToolsDialog
          request={tableTool}
          sessions={w.sessions}
          onClose={() => setTableTool(null)}
          onDone={(connectionId, database, message, target) => {
            invalidateDatabase(connectionId, database);
            setTableTool(null);
            setNotice(message, "success");
            if (target) {
              for (const t of useWorkspace.getState().tabs) {
                const source = t.result?.source;
                if (
                  t.connectionId === connectionId &&
                  source?.database === database &&
                  source.table.name === target.name &&
                  source.table.schema === target.schema &&
                  !t.running &&
                  !(t.staged && pendingCount(t.staged))
                ) {
                  void runTableView(
                    t.id,
                    connectionId,
                    database,
                    target,
                    t.result?.pagination?.page ?? 1,
                    t.result?.pagination?.page_size ?? 1000,
                    source.filters ?? [],
                    source.sort,
                  );
                }
              }
            }
          }}
        />
      )}
      {modal && (
        <ConnectionDialog
          onClose={() => setModal(false)}
          onConnected={connected}
        />
      )}{" "}
      {areaMenu && (
        <AreaContextMenu menu={areaMenu} onClose={() => setAreaMenu(null)} />
      )}
      {help && <HelpDialog onClose={() => setHelp(false)} />}
    </div>
  );
}
function ShieldIcon() {
  return <Database size={16} />;
}
