import { lazy, Suspense, useEffect, useRef, useState } from "react";
import {
  Database,
  Plus,
  ChevronDown,
  ChevronRight,
  Search,
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
} from "lucide-react";
import type * as Monaco from "monaco-editor";
import { useWorkspace } from "./store";
import * as api from "./lib/api";
import type {
  ColumnInfo,
  ConnectionConfig,
  Session,
  TableInfo,
  TableFilter,
  TableSort,
  QueryTab,
  TableSource,
} from "./types";
import { tableQuery } from "./lib/sql";
import { rowKeys } from "./lib/rows";
import ResultGrid from "./components/ResultGrid";
import ConnectionDialog from "./components/ConnectionDialog";
const QueryEditor = lazy(() => import("./components/QueryEditor"));
function ExplorerTable({
  session,
  table,
  database,
  onOpen,
}: {
  session: Session;
  table: TableInfo;
  database: string;
  onOpen: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const [cols, setCols] = useState<ColumnInfo[]>();
  const [error, setError] = useState("");
  async function toggle() {
    setExpanded(!expanded);
    if (!expanded && !cols)
      try {
        setCols(await api.columns(session.id, table, database));
      } catch (e) {
        setError(String(e));
      }
  }
  return (
    <>
      <div className="table-node">
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
          <span>
            {table.schema && table.schema !== "public"
              ? table.schema + "."
              : ""}
            {table.name}
          </span>
          <span className="node-kind">
            {table.kind === "view" ? "view" : ""}
          </span>
        </button>
      </div>
      {expanded && (
        <div className="column-nodes">
          {error ? (
            <span className="error">{error}</span>
          ) : !cols ? (
            <span>Loading columns…</span>
          ) : (
            cols.map((c) => (
              <div
                key={c.name}
                title={`${c.data_type}${c.nullable ? " · nullable" : " · not null"}`}
              >
                <Columns3 size={11} />
                <span>{c.name}</span>
                <small>{c.data_type}</small>
              </div>
            ))
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
}: {
  session: Session;
  database: string;
  search: string;
  onOpen: (table: TableInfo) => void;
  onQuery: () => void;
}) {
  const [expanded, setExpanded] = useState(
    session.config.driver === "sqlite" || session.config.database === database,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const tree = session.trees?.[database];
  const request = useRef(0);
  async function load() {
    const version = ++request.current;
    setLoading(true);
    setError("");
    try {
      const tree = await api.schema(session.id, database);
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
    if (expanded && !tree && !loading && !error) void load();
  }, [expanded, tree, loading, error]);
  return (
    <div className="database-branch">
      <div className="database-node">
        <button
          className="database-toggle"
          aria-expanded={expanded}
          onClick={() => setExpanded(!expanded)}
        >
          <span>
            {expanded ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
          </span>
          <Layers size={13} />
          <span title={database}>{database}</span>
        </button>
        <button
          className="icon-button"
          aria-label={`New query in ${database}`}
          title="New query in this database"
          onClick={onQuery}
        >
          <Plus size={12} />
        </button>
        <button
          className="icon-button"
          aria-label={`Refresh ${database}`}
          disabled={loading}
          onClick={() => void load()}
        >
          <RefreshCw size={12} className={loading ? "spin" : ""} />
        </button>
      </div>
      {expanded && (
        <>
          {loading && !tree && (
            <div className="empty-inline">Loading tables…</div>
          )}
          {error && <div className="tree-error">{error}</div>}
          {tree && (
            <>
              <div className="tree-section">
                Tables & views <span>{tree.tables.length}</span>
              </div>
              {tree.tables
                .filter((t) =>
                  t.name.toLowerCase().includes(search.toLowerCase()),
                )
                .map((t) => (
                  <ExplorerTable
                    key={`${t.schema}.${t.name}`}
                    session={session}
                    table={t}
                    database={database}
                    onOpen={() => onOpen(t)}
                  />
                ))}
              {!tree.tables.length && (
                <div className="empty-inline">No tables yet.</div>
              )}
            </>
          )}
        </>
      )}
    </div>
  );
}
export default function App() {
  const w = useWorkspace();
  const tab = w.tabs.find((t) => t.id === w.activeTab);
  const session =
    w.sessions.find((s) => s.id === tab?.connectionId) ?? w.sessions[0];
  const [modal, setModal] = useState(false);
  const [profiles, setProfiles] = useState<ConnectionConfig[]>([]);
  const [search, setSearch] = useState("");
  const [notice, setNotice] = useState("");
  const [collapsed, setCollapsed] = useState<string[]>([]);
  const [help, setHelp] = useState(false);
  const [explorerOpen, setExplorerOpen] = useState(
    () => typeof window === "undefined" || window.innerWidth > 520,
  );
  const [tableFocus, setTableFocus] = useState(false);
  const editorOpen = (tab?.editorOpen ?? !tab?.result?.source) && !tableFocus;
  useEffect(() => setTableFocus(false), [tab?.id]);
  const editor = useRef<Monaco.editor.IStandaloneCodeEditor | null>(null);
  const pending = useRef(new Set<string>());
  useEffect(() => {
    api
      .listProfiles()
      .then(setProfiles)
      .catch((e) => setNotice(String(e)));
  }, []);
  async function refresh(id: string) {
    useWorkspace
      .getState()
      .updateSession(id, { loading: true, error: undefined });
    try {
      const databases = await api.listDatabases(id);
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
    pending.current.add(id);
    w.updateTab(id, {
      running: true,
      error: undefined,
      tableIdentity: undefined,
    });
    try {
      // The tab ID pins a server session so transactions and SET persist between runs.
      const result = await api.execute(connectionId, query, database, id);
      useWorkspace.getState().updateTab(id, { result });
    } catch (e) {
      useWorkspace
        .getState()
        .updateTab(id, { error: String(e), result: undefined });
    } finally {
      pending.current.delete(id);
      useWorkspace.getState().updateTab(id, { running: false });
    }
  }
  function run(selection?: string) {
    if (!tab) return;
    const selected =
      selection ??
      (editor.current?.getSelection()
        ? editor.current
            .getModel()
            ?.getValueInRange(editor.current.getSelection()!)
        : "");
    void runQuery(
      tab.id,
      tab.connectionId,
      selected?.trim() ? selected : tab.query,
      tab.database,
    );
  }
  async function closeConnection(id: string) {
    try {
      await api.disconnect(id);
      w.removeSession(id);
    } catch (e) {
      setNotice(String(e));
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
  const openTable = (s: Session, t: TableInfo, database: string) => {
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
    void runTableView(id, s.id, database, t);
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
                  1) /
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
      className={`app ${tab ? "has-workspace" : ""} ${!explorerOpen ? "explorer-hidden" : ""} ${tableFocus ? "table-focused" : ""}`}
    >
      <header className="titlebar">
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
        <div className="brand">
          <span className="brand-mark">
            <Database size={18} />
          </span>{" "}
          DBde <span className="brand-sub">DATABASE DESKTOP</span>
        </div>
        <div className="title-center">
          <span className="dot" /> Local workspace
        </div>
        <button
          className="icon-button"
          aria-label="Help and shortcuts"
          onClick={() => setHelp(true)}
        >
          <CircleHelp size={17} />
        </button>
      </header>
      <div className="app-body">
        <aside className="sidebar">
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
              placeholder="Find a table…"
              aria-label="Find a table"
            />
            <kbd>⌕</kbd>
          </label>
          <div className="sidebar-scroll">
            {w.sessions.map((s) => (
              <div className="connection-tree" key={s.id}>
                <div className="connection-heading">
                  <button
                    onClick={() =>
                      setCollapsed((c) =>
                        c.includes(s.id)
                          ? c.filter((id) => id !== s.id)
                          : [...c, s.id],
                      )
                    }
                  >
                    {collapsed.includes(s.id) ? (
                      <ChevronRight size={13} />
                    ) : (
                      <ChevronDown size={13} />
                    )}
                    <Database size={15} />
                    <span>{s.config.name}</span>
                    <span className="dot" />
                  </button>
                  <button
                    className="icon-button"
                    aria-label={`Disconnect ${s.config.name}`}
                    onClick={() => void closeConnection(s.id)}
                  >
                    <Unplug size={13} />
                  </button>
                </div>
                {!collapsed.includes(s.id) && (
                  <>
                    <div className="tree-section">
                      Databases <span>{s.databases?.length ?? "—"}</span>
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
                        onOpen={(t) => openTable(s, t, database)}
                        onQuery={() =>
                          w.addTab(
                            s.id,
                            undefined,
                            `Query · ${database}`,
                            database,
                          )
                        }
                      />
                    ))}
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
                  <div className="saved-row" key={p.id}>
                    <button onClick={() => void openSaved(p)}>
                      <Database size={14} />
                      {p.name}
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
        </aside>
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
            <div className="notice" role="alert">
              {notice}
              <button
                className="icon-button"
                onClick={() => setNotice("")}
                aria-label="Dismiss error"
              >
                <X size={14} />
              </button>
            </div>
          )}
          {tab ? (
            <>
              <div className="tabs">
                {w.tabs.map((t) => (
                  <div
                    className={`tab ${w.activeTab === t.id ? "active" : ""}`}
                    key={t.id}
                  >
                    <button
                      onClick={() => w.setActive(t.id)}
                      onDoubleClick={() => {
                        const name = window.prompt("Query tab name", t.name);
                        if (name?.trim())
                          w.updateTab(t.id, { name: name.trim() });
                      }}
                    >
                      <FileCode2 size={14} />
                      {t.name}
                      {t.running && <Loader2 size={12} className="spin" />}
                    </button>
                    <button
                      className="tab-close"
                      aria-label={`Close ${t.name}`}
                      onClick={() => {
                        void api
                          .closeSession(t.connectionId, t.id)
                          .catch((e) => setNotice(String(e)));
                        w.closeTab(t.id);
                      }}
                      disabled={t.running}
                    >
                      <X size={12} />
                    </button>
                  </div>
                ))}
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
              </div>
              <div className="editor-toolbar">
                <span className="workspace-kind">
                  <Table2 size={14} />
                  {tab.result?.source ? "Table data" : "SQL workspace"}
                </span>
                <span className="editor-connection">
                  <span className="dot" />
                  <select
                    aria-label="Query database"
                    value={tab.database ?? ""}
                    disabled={tab.running || !session?.databases?.length}
                    onChange={(e) =>
                      w.updateTab(tab.id, {
                        database: e.target.value,
                        result: undefined,
                        error: undefined,
                      })
                    }
                  >
                    {!tab.database && <option value="">Choose database</option>}
                    {session?.databases?.map((database) => (
                      <option key={database} value={database}>
                        {database}
                      </option>
                    ))}
                  </select>
                </span>
                <span className="spacer" />
                {tab.result?.source && (
                  <button
                    className="button subtle"
                    aria-label="Refresh table data"
                    disabled={tab.running}
                    onClick={() => {
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
                  aria-label={tableFocus ? "Exit table focus" : "Focus table"}
                  aria-pressed={tableFocus}
                  disabled={!tab.result}
                  onClick={() => setTableFocus(!tableFocus)}
                >
                  {tableFocus ? (
                    <Minimize2 size={14} />
                  ) : (
                    <Maximize2 size={14} />
                  )}
                  <span>{tableFocus ? "Exit focus" : "Focus table"}</span>
                </button>
                {editorOpen && (
                  <>
                    <button
                      className="button subtle"
                      title="Format SQL"
                      onClick={async () => {
                        try {
                          const { format } = await import("sql-formatter");
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
                    <button
                      className="button primary run"
                      onClick={() => run()}
                      disabled={tab.running}
                    >
                      {tab.running ? (
                        <Loader2 size={13} className="spin" />
                      ) : (
                        <Play size={12} fill="currentColor" />
                      )}
                      {tab.running ? "Running…" : "Run query"}
                      <kbd>
                        {navigator.platform.includes("Mac") ? "⌘" : "Ctrl"} ↵
                      </kbd>
                    </button>
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
                      onRun={run}
                      tables={
                        session?.trees?.[tab.database ?? ""]?.tables ?? []
                      }
                      editorRef={editor}
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
              {tab.error ? (
                <div className="query-error" role="alert">
                  <Terminal size={23} />
                  <h3>Query could not be completed</h3>
                  <pre>{tab.error}</pre>
                </div>
              ) : tab.result ? (
                <ResultGrid
                  key={tab.id}
                  result={tab.result}
                  busy={tab.running}
                  onDelete={deleteSelectedRows}
                  onUpdateCell={(row, column, value) =>
                    writeRecord((current, source) =>
                      api.updateCell(
                        current.connectionId,
                        source,
                        rowKeys(current.result!, [row])[0],
                        column,
                        value,
                      ),
                    )
                  }
                  onInsertRecord={(values) =>
                    writeRecord(
                      (current, source) =>
                        api.insertRecord(current.connectionId, source, values),
                      true,
                    )
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
          ) : (
            <div className="welcome">
              <div className="welcome-symbol">
                <Database size={38} />
                <span className="dot" />
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
      {modal && (
        <ConnectionDialog
          onClose={() => setModal(false)}
          onConnected={connected}
        />
      )}{" "}
      {help && (
        <div
          className="modal-backdrop"
          onClick={(e) => e.target === e.currentTarget && setHelp(false)}
        >
          <section
            className="modal help"
            role="dialog"
            aria-modal="true"
            aria-labelledby="help-title"
          >
            <button
              className="icon-button help-close"
              onClick={() => setHelp(false)}
              aria-label="Close help"
            >
              <X size={18} />
            </button>
            <h2 id="help-title">A workspace that stays local</h2>
            <p>
              The desktop app connects to PostgreSQL, MySQL, and SQLite through
              Rust. Saved passwords live in your OS credential vault.
            </p>
            <p>
              The browser sandbox runs a real, temporary SQLite database. Use
              SELECT, JOIN, CREATE, INSERT, UPDATE, and DELETE to explore.
              Reloading resets the data.
            </p>
            <div className="help-shortcut">
              <span>Run query or selected SQL</span>
              <kbd>⌘ / Ctrl + Enter</kbd>
            </div>
            <div className="help-shortcut">
              <span>Rename a tab</span>
              <span>Double-click its name</span>
            </div>
            <p>
              Result sets are limited to 50,000 rows in the desktop app. Query
              timeout: 30 seconds. MongoDB and SSH tunneling are planned for
              phase 2.
            </p>
          </section>
        </div>
      )}
    </div>
  );
}
function ShieldIcon() {
  return <Database size={16} />;
}
