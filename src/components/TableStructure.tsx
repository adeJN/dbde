import { useEffect, useRef, useState } from "react";
import {
  Check,
  ChevronRight,
  Code2,
  Columns3,
  Copy,
  Database,
  FileCode2,
  KeyRound,
  ListTree,
  Loader2,
  RefreshCw,
  Save,
  Table2,
  X,
} from "lucide-react";
import type { ColumnInfo, IndexInfo, Session, TableInfo } from "../types";
import * as api from "../lib/api";
import { writeClipboard } from "../lib/clipboard";
import { qualifiedName, quoteIdentifier } from "../lib/sql";
import { fieldRenameError, type FieldRename } from "../lib/field-renames";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
import FieldPropertyEditor from "./FieldPropertyEditor";
import { fieldTypes } from "../lib/table-designer";
import {
  fieldChangesError,
  initialFieldType,
  initialDefault,
  lengthType,
  scaleType,
  numericType,
  textType,
  type FieldPatch,
  type FieldChange,
} from "../lib/field-changes";
import {
  loadTableDetails,
  type StructureDetails,
  type StructureDefinition,
} from "../lib/table-structure";

export interface TableStructureRequest {
  session: Session;
  database: string;
  table: TableInfo;
}

export default function TableStructure({
  request: { session, database, table },
  onClose,
  onEdit,
  onBeforeSave,
  onSaved,
}: {
  request: TableStructureRequest;
  onClose: () => void;
  onEdit: (sql: string) => void;
  onBeforeSave?: () => void | Promise<void>;
  onSaved?: (renames: FieldRename[]) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [pane, setPane] = useState("Fields");
  const [search, setSearch] = useState("");
  const [selected, setSelected] = useState("");
  const [data, setData] = useState<{
    columns: ColumnInfo[];
    indexes: IndexInfo[];
    ddl: string;
    details: StructureDetails;
  }>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [version, refresh] = useState(0);
  const [copied, setCopied] = useState(false);
  const [copyError, setCopyError] = useState("");
  const [names, setNames] = useState(new Map<string, string>());
  const [patches, setPatches] = useState(new Map<string, FieldPatch>());
  const [previewSql, setPreviewSql] = useState("");
  const [previewError, setPreviewError] = useState("");
  const [previewBusy, setPreviewBusy] = useState(false);
  const [busy, setBusy] = useState(false);
  const saving = useRef(false);
  const [saveError, setSaveError] = useState("");
  const [success, setSuccess] = useState("");
  const successEvents = useAutoDismiss(success, () => setSuccess(""));
  const [discard, setDiscard] = useState<"close" | "refresh" | null>(null);
  const renames = Array.from(names, ([from, to]) => ({ from, to }));
  const changes: FieldChange[] = Array.from(
    new Set([...names.keys(), ...patches.keys()]),
    (from) => ({
      from,
      to: names.get(from) ?? from,
      patch: patches.get(from) ?? {},
    }),
  );
  const dirty = changes.length > 0;
  const isView = table.kind === "view";
  const propertiesSupported = session.config.driver === "mysql" && !isView;
  const validation =
    (data
      ? fieldRenameError(
          data.columns.map((column) => column.name),
          renames,
          session.config.driver,
        )
      : "") ||
    (data && patches.size
      ? fieldChangesError(data.columns, data.details.fields, changes)
      : "");
  const copyTimer = useRef<ReturnType<typeof setTimeout>>();
  const tabs = [
    "Fields",
    ...(!isView
      ? ["Indexes", "Foreign Keys", "Triggers", "Checks", "Options", "Comment"]
      : []),
    "SQL Preview",
  ];
  const field = data?.columns.find((column) => column.name === selected);
  const visible =
    data?.columns.filter((column) =>
      `${names.get(column.name) ?? column.name} ${column.data_type}`
        .toLowerCase()
        .includes(search.toLowerCase()),
    ) ?? [];
  const fieldIndexes =
    data?.indexes.filter((index) => index.columns.includes(selected)) ?? [];
  const primary = new Set(
    data?.indexes
      .filter((index) => index.primary)
      .flatMap((index) => index.columns),
  );
  for (const column of data?.details.fields ?? [])
    if (column.primary) primary.add(column.name);
  const fieldDetail = data?.details.fields.find(
    (column) => column.name === selected,
  );
  const fieldPatch = patches.get(selected) ?? {};

  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLButtonElement>('[role="tab"]')?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
      clearTimeout(copyTimer.current);
    };
  }, []);
  useEffect(() => {
    let active = true;
    setLoading(true);
    setError("");
    setData(undefined);
    Promise.all([
      api.columns(session.id, table, database),
      isView
        ? Promise.resolve([] as IndexInfo[])
        : api.listIndexes(session.id, table, database),
      api.tableDdl(session.id, table, database),
      loadTableDetails(session.id, database, table, session.config.driver),
    ])
      .then(([baseColumns, indexes, ddl, details]) => {
        if (!active) return;
        const columns = [...baseColumns];
        for (const extra of details.fields) {
          if (!columns.some((column) => column.name === extra.name))
            columns.push({
              name: extra.name,
              data_type: `${extra.type}${extra.length ? `(${extra.length}${extra.decimals ? `,${extra.decimals}` : ""})` : ""}`,
              nullable: extra.nullable,
            });
        }
        setData({ columns, indexes, ddl, details });
        setSelected((current) =>
          columns.some((column) => column.name === current)
            ? current
            : (columns[0]?.name ?? ""),
        );
      })
      .catch((cause) => active && setError(String(cause)))
      .finally(() => active && setLoading(false));
    return () => {
      active = false;
    };
  }, [session.id, database, table.name, table.schema, isView, version]);

  const serializedChanges = JSON.stringify(changes);
  useEffect(() => {
    if (pane !== "SQL Preview" || !dirty || validation || loading) {
      setPreviewSql("");
      setPreviewError("");
      setPreviewBusy(false);
      return;
    }
    if (!propertiesSupported) {
      setPreviewSql(
        JSON.parse(serializedChanges)
          .map(
            (change: FieldChange) =>
              `ALTER TABLE ${qualifiedName(table, session.config.driver)} RENAME COLUMN ${quoteIdentifier(change.from, session.config.driver)} TO ${quoteIdentifier(change.to, session.config.driver)};`,
          )
          .join("\n"),
      );
      setPreviewError("");
      setPreviewBusy(false);
      return;
    }
    let active = true;
    setPreviewSql("");
    setPreviewError("");
    setPreviewBusy(true);
    const timer = window.setTimeout(() => {
      api
        .alterTableFields(
          session.id,
          database,
          table,
          JSON.parse(serializedChanges),
          true,
        )
        .then((sql) => {
          if (active) setPreviewSql(sql);
        })
        .catch((cause) => {
          if (active) setPreviewError(String(cause));
        })
        .finally(() => {
          if (active) setPreviewBusy(false);
        });
    }, 300);
    return () => {
      active = false;
      clearTimeout(timer);
    };
  }, [
    pane,
    dirty,
    validation,
    propertiesSupported,
    loading,
    serializedChanges,
    session.id,
    database,
    table.name,
    table.schema,
  ]);

  function changeProps(from: string, value: FieldPatch) {
    if (!propertiesSupported || busy || !data) return;
    const column = data.columns.find((item) => item.name === from);
    const detail = data.details.fields.find((item) => item.name === from);
    if (!column || !detail) return;
    const original: FieldPatch = {
      data_type: initialFieldType(column, detail),
      not_null: !column.nullable,
      comment: detail.comment,
      default: initialDefault(detail),
      charset: detail.charset ?? "",
      collation: detail.collation ?? "",
      generated: detail.generated,
      stored: detail.stored,
      expression: detail.expression,
      primary: primary.has(from),
      auto_increment: detail.auto_increment,
    };
    setPatches((current) => {
      const next = new Map(current),
        merged = { ...current.get(from), ...value };
      for (const key of Object.keys(merged) as (keyof FieldPatch)[])
        if (JSON.stringify(merged[key]) === JSON.stringify(original[key]))
          delete merged[key];
      if (Object.keys(merged).length) next.set(from, merged);
      else next.delete(from);
      return next;
    });
    setSaveError("");
    setSuccess("");
  }

  function changeName(from: string, to: string) {
    setNames((current) => {
      const next = new Map(current);
      if (from === to) next.delete(from);
      else next.set(from, to);
      return next;
    });
    setSaveError("");
    setSuccess("");
  }
  function dismiss(action: "close" | "refresh" = "close") {
    if (saving.current) return;
    if (dirty) {
      setDiscard(action);
      return;
    }
    if (action === "close") onClose();
    else refresh((current) => current + 1);
  }
  async function save() {
    if (
      saving.current ||
      loading ||
      !data ||
      !dirty ||
      validation ||
      isView ||
      discard
    )
      return;
    saving.current = true;
    setBusy(true);
    setSaveError("");
    try {
      await onBeforeSave?.();
      if (patches.size)
        await api.alterTableFields(session.id, database, table, changes);
      else await api.renameTableFields(session.id, database, table, renames);
      setSelected((current) => names.get(current) ?? current);
      setNames(new Map());
      setPatches(new Map());
      setSuccess(
        `${changes.length} field${changes.length === 1 ? "" : "s"} saved.`,
      );
      refresh((current) => current + 1);
      onSaved?.(renames);
    } catch (cause) {
      setSaveError(String(cause));
    } finally {
      saving.current = false;
      setBusy(false);
    }
  }

  function edit() {
    if (!data || loading || error || dirty || saving.current) return;
    const definition = data.ddl
      .split("\n")
      .map((line) => `-- ${line}`)
      .join("\n");
    const template = isView
      ? "-- Rewrite the definition above as CREATE OR REPLACE VIEW and run it."
      : `ALTER TABLE ${qualifiedName(table, session.config.driver)}\n  ADD COLUMN new_column TEXT;`;
    onEdit(
      `-- Current definition of ${table.name.replace(/[\r\n]/g, " ")}\n${definition}\n\n${template}\n`,
    );
  }
  async function copySql() {
    if (!data) return;
    try {
      setCopyError("");
      await writeClipboard(dirty ? previewSql : data.ddl);
      setCopied(true);
      clearTimeout(copyTimer.current);
      copyTimer.current = setTimeout(() => setCopied(false), 2500);
    } catch (cause) {
      setCopyError(String(cause));
    }
  }

  function definitions(title: string, entries: StructureDefinition[]) {
    const unavailable =
      data?.details.unavailable.includes(title) ||
      ((title === "Checks" || title === "Foreign Keys") &&
        data?.details.unavailable.includes("Constraints"));
    return (
      <div className="designer-section structure-definitions">
        <div className="designer-section-heading">
          <div>
            <h3>{title}</h3>
            <p>
              {title === "Triggers"
                ? "Database actions attached to this table."
                : title === "Checks"
                  ? "Expressions that validate records in this table."
                  : "Relationships to other tables."}
            </p>
          </div>
        </div>
        {unavailable ? (
          <div className="designer-empty">
            <FileCode2 size={26} />
            <strong>{title} metadata is unavailable</strong>
            <span>
              Check the SQL Preview or refresh with an account that can read
              this metadata.
            </span>
          </div>
        ) : entries.length ? (
          entries.map((entry) => (
            <article className="structure-definition-card" key={entry.name}>
              <header>
                <strong>{entry.name}</strong>
                {entry.timing && (
                  <span>
                    {entry.timing} {entry.event}
                  </span>
                )}
              </header>
              <pre tabIndex={0}>{entry.definition}</pre>
            </article>
          ))
        ) : (
          <div className="designer-empty">
            <ListTree size={26} />
            <strong>No {title.toLowerCase()}</strong>
            <span>No definitions were returned by the database.</span>
          </div>
        )}
      </div>
    );
  }

  return (
    <div className="modal-backdrop table-designer-backdrop">
      <section
        className="table-designer structure-designer"
        role="dialog"
        aria-modal="true"
        aria-labelledby="structure-title"
        ref={root}
        onKeyDown={(event) => {
          if (
            (event.metaKey || event.ctrlKey) &&
            event.key.toLowerCase() === "s"
          ) {
            event.preventDefault();
            void save();
            return;
          }
          if (event.key === "Escape") {
            event.preventDefault();
            if (discard) setDiscard(null);
            else dismiss();
          }
          if (event.key === "Tab") {
            const controls = Array.from(
              root.current?.querySelectorAll<HTMLElement>(
                'button:not(:disabled):not([tabindex="-1"]), input:not(:disabled), textarea:not(:disabled), [tabindex="0"]',
              ) ?? [],
            );
            const first = controls[0],
              last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        }}
      >
        <header className="designer-heading structure-heading">
          <div className="designer-title-icon">
            <Table2 size={21} />
          </div>
          <div className="structure-heading-name">
            <div className="structure-eyebrow">
              {isView ? "VIEW STRUCTURE" : "TABLE DESIGNER"}
            </div>
            <h2 id="structure-title">
              {table.name}
              <span>Design {isView ? "View" : "Table"}</span>
            </h2>
            <p>
              <Database size={12} />
              {session.config.name}
              <ChevronRight size={12} />
              {database}
              {table.schema && table.schema !== database && (
                <>
                  <ChevronRight size={12} />
                  {table.schema}
                </>
              )}
            </p>
          </div>
          <span className="structure-driver">
            {session.config.driver === "mysql"
              ? "MySQL / MariaDB"
              : session.config.driver === "postgres"
                ? "PostgreSQL"
                : "SQLite"}
          </span>
          <button
            className="icon-button"
            aria-label="Close table design"
            disabled={busy}
            onClick={() => dismiss()}
          >
            <X size={18} />
          </button>
        </header>
        <div className="structure-navigation">
          <div
            className="designer-tabs"
            role="tablist"
            aria-label="Structure sections"
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : (tabs.indexOf(pane) +
                        (event.key === "ArrowRight" ? 1 : -1) +
                        tabs.length) %
                      tabs.length;
              setPane(tabs[next]);
              root.current
                ?.querySelector<HTMLButtonElement>(`#structure-tab-${next}`)
                ?.focus();
            }}
          >
            {tabs.map((tab, index) => (
              <button
                key={tab}
                id={`structure-tab-${index}`}
                role="tab"
                aria-controls="structure-panel"
                aria-selected={pane === tab}
                tabIndex={pane === tab ? 0 : -1}
                onClick={() => setPane(tab)}
                disabled={busy}
              >
                {tab === "Fields" ? (
                  <Columns3 size={14} />
                ) : tab === "Indexes" ? (
                  <ListTree size={14} />
                ) : (
                  <FileCode2 size={14} />
                )}
                {tab}
                {[
                  "Fields",
                  "Indexes",
                  "Foreign Keys",
                  "Triggers",
                  "Checks",
                ].includes(tab) && (
                  <small aria-hidden="true">
                    {!data
                      ? "—"
                      : tab === "Fields"
                        ? data.columns.length
                        : tab === "Indexes"
                          ? data.indexes.length
                          : tab === "Foreign Keys"
                            ? data.details.foreignKeys.length
                            : tab === "Triggers"
                              ? data.details.triggers.length
                              : data.details.checks.length}
                  </small>
                )}
              </button>
            ))}
          </div>
          <button
            className="designer-tool"
            disabled={loading || busy}
            onClick={() => dismiss("refresh")}
            title="Refresh structure"
          >
            <RefreshCw size={14} className={loading ? "spin" : ""} />
            Refresh
          </button>
        </div>
        {error && (
          <div className="structure-load-error" role="alert">
            <span>{error}</span>
            <button
              className="button secondary"
              onClick={() => refresh((current) => current + 1)}
            >
              Retry
            </button>
          </div>
        )}
        <div
          className="designer-panel structure-panel"
          id="structure-panel"
          role="tabpanel"
          aria-labelledby={`structure-tab-${tabs.indexOf(pane)}`}
          aria-busy={loading}
        >
          {loading ? (
            <div className="structure-loading" role="status">
              <Loader2 size={23} className="spin" />
              <strong>Loading table structure…</strong>
              <span>Reading fields, indexes and definition</span>
            </div>
          ) : (
            data && (
              <>
                {pane === "Fields" && (
                  <div className="structure-fields-layout">
                    <div className="structure-fields-main">
                      <div className="structure-field-toolbar">
                        <span>
                          <Columns3 size={14} />
                          Fields <small>{data.columns.length}</small>
                        </span>
                        <label className="structure-search">
                          Find field
                          <input
                            aria-label="Search structure fields"
                            placeholder="Filter by name or type…"
                            value={search}
                            onChange={(event) => setSearch(event.target.value)}
                          />
                        </label>
                      </div>
                      <div className="designer-grid-scroll">
                        <table
                          className="designer-grid structure-grid"
                          aria-label="Table fields"
                        >
                          <colgroup>
                            <col style={{ width: 40 }} />
                            <col style={{ width: "18%" }} />
                            <col style={{ width: "18%" }} />
                            <col style={{ width: 90 }} />
                            <col style={{ width: 90 }} />
                            <col style={{ width: 90 }} />
                            <col style={{ width: 80 }} />
                            <col style={{ width: 80 }} />
                            <col />
                          </colgroup>
                          <thead>
                            <tr>
                              <th>#</th>
                              <th>Name</th>
                              <th>Type</th>
                              <th>Length</th>
                              <th>Decimals</th>
                              <th>Not Null</th>
                              <th>Virtual</th>
                              <th>Key</th>
                              <th>Comment</th>
                            </tr>
                          </thead>
                          <tbody>
                            {visible.map((column) => {
                              const detail = data.details.fields.find(
                                (item) => item.name === column.name,
                              );
                              const patch = patches.get(column.name) ?? {};
                              const type =
                                patch.data_type ??
                                initialFieldType(column, detail);
                              const editable =
                                propertiesSupported && !!detail && !busy;
                              const required =
                                patch.not_null ?? !column.nullable;
                              const isPrimary =
                                patch.primary ?? primary.has(column.name);
                              return (
                                <tr
                                  key={column.name}
                                  data-dirty={
                                    names.has(column.name) ||
                                    patches.has(column.name)
                                  }
                                  aria-selected={selected === column.name}
                                  tabIndex={
                                    selected === column.name ||
                                    (!visible.some(
                                      (item) => item.name === selected,
                                    ) &&
                                      visible[0] === column)
                                      ? 0
                                      : -1
                                  }
                                  onClick={() => setSelected(column.name)}
                                  onFocus={() => setSelected(column.name)}
                                  onKeyDown={(event) => {
                                    if (
                                      event.target instanceof HTMLInputElement
                                    )
                                      return;
                                    if (
                                      ![
                                        "ArrowDown",
                                        "ArrowUp",
                                        "Home",
                                        "End",
                                      ].includes(event.key)
                                    )
                                      return;
                                    event.preventDefault();
                                    const index = visible.indexOf(column);
                                    const next =
                                      event.key === "Home"
                                        ? 0
                                        : event.key === "End"
                                          ? visible.length - 1
                                          : Math.max(
                                              0,
                                              Math.min(
                                                visible.length - 1,
                                                index +
                                                  (event.key === "ArrowDown"
                                                    ? 1
                                                    : -1),
                                              ),
                                            );
                                    const rows =
                                      event.currentTarget.parentElement?.querySelectorAll<HTMLTableRowElement>(
                                        "tr",
                                      );
                                    rows?.[next]?.focus();
                                  }}
                                >
                                  <td className="designer-row-number">
                                    {data.columns.indexOf(column) + 1}
                                  </td>
                                  <td className="structure-field-name">
                                    <input
                                      aria-label={`Field ${column.name} name`}
                                      value={
                                        names.get(column.name) ?? column.name
                                      }
                                      readOnly={isView}
                                      disabled={busy}
                                      className={
                                        names.has(column.name)
                                          ? "structure-name-draft"
                                          : ""
                                      }
                                      aria-invalid={
                                        names.has(column.name) && !!validation
                                      }
                                      title={
                                        isView
                                          ? "View fields are read-only"
                                          : "Edit field name · Save with ⌘/Ctrl+S"
                                      }
                                      onChange={(event) =>
                                        changeName(
                                          column.name,
                                          event.target.value,
                                        )
                                      }
                                      onKeyDown={(event) => {
                                        if (event.key === "Enter") {
                                          event.preventDefault();
                                          event.currentTarget.blur();
                                          event.currentTarget
                                            .closest<HTMLTableRowElement>("tr")
                                            ?.focus();
                                        }
                                        if (
                                          event.key === "Escape" &&
                                          names.has(column.name)
                                        ) {
                                          event.preventDefault();
                                          event.stopPropagation();
                                          changeName(column.name, column.name);
                                        }
                                      }}
                                    />
                                  </td>
                                  <td className="structure-field-type">
                                    <select
                                      aria-label={`${column.name} type`}
                                      value={type.name}
                                      disabled={!editable}
                                      onChange={(event) => {
                                        const name = event.target.value;
                                        const next = {
                                          ...type,
                                          name,
                                          length: [
                                            "varchar",
                                            "char",
                                            "binary",
                                            "varbinary",
                                          ].includes(name)
                                            ? "255"
                                            : ["decimal", "numeric"].includes(
                                                  name,
                                                )
                                              ? "10"
                                              : "",
                                          decimals: [
                                            "decimal",
                                            "numeric",
                                          ].includes(name)
                                            ? "2"
                                            : "",
                                          unsigned:
                                            numericType(name) && type.unsigned,
                                          zerofill:
                                            numericType(name) && type.zerofill,
                                          values: ["enum", "set"].includes(name)
                                            ? type.values
                                            : [],
                                        };
                                        changeProps(column.name, {
                                          data_type: next,
                                          ...(!textType(name)
                                            ? { charset: "", collation: "" }
                                            : {}),
                                          ...(!/^(?:tinyint|smallint|mediumint|int|integer|bigint)$/.test(
                                            name,
                                          )
                                            ? { auto_increment: false }
                                            : {}),
                                        });
                                      }}
                                    >
                                      {Array.from(
                                        new Set([
                                          type.name,
                                          ...fieldTypes[session.config.driver],
                                        ]),
                                      ).map((name) => (
                                        <option key={name}>{name}</option>
                                      ))}
                                    </select>
                                  </td>
                                  <td className="structure-dimension">
                                    <input
                                      aria-label={`${column.name} length`}
                                      value={type.length}
                                      inputMode="numeric"
                                      pattern="[0-9]*"
                                      disabled={
                                        !editable || !lengthType(type.name)
                                      }
                                      onChange={(event) => {
                                        if (/^\d*$/.test(event.target.value))
                                          changeProps(column.name, {
                                            data_type: {
                                              ...type,
                                              length: event.target.value,
                                            },
                                          });
                                      }}
                                    />
                                  </td>
                                  <td className="structure-dimension">
                                    <input
                                      aria-label={`${column.name} decimals`}
                                      value={type.decimals}
                                      inputMode="numeric"
                                      pattern="[0-9]*"
                                      disabled={
                                        !editable || !scaleType(type.name)
                                      }
                                      onChange={(event) => {
                                        if (/^\d*$/.test(event.target.value))
                                          changeProps(column.name, {
                                            data_type: {
                                              ...type,
                                              decimals: event.target.value,
                                            },
                                          });
                                      }}
                                    />
                                  </td>
                                  <td className="structure-flag">
                                    <input
                                      type="checkbox"
                                      aria-label={`${column.name} not null`}
                                      checked={required}
                                      disabled={
                                        !editable ||
                                        isPrimary ||
                                        (patch.auto_increment ??
                                          detail?.auto_increment)
                                      }
                                      onChange={(event) =>
                                        changeProps(column.name, {
                                          not_null: event.target.checked,
                                        })
                                      }
                                    />
                                  </td>
                                  <td className="structure-flag">
                                    <input
                                      type="checkbox"
                                      aria-label={`${column.name} virtual`}
                                      checked={
                                        patch.generated ??
                                        detail?.generated ??
                                        false
                                      }
                                      disabled={!editable}
                                      onChange={(event) =>
                                        changeProps(
                                          column.name,
                                          event.target.checked
                                            ? {
                                                generated: true,
                                                stored: detail?.generated
                                                  ? detail.stored
                                                  : true,
                                                default: {
                                                  kind: "none",
                                                  value: "",
                                                },
                                                auto_increment: false,
                                              }
                                            : { generated: false },
                                        )
                                      }
                                    />
                                  </td>
                                  <td className="structure-flag">
                                    <button
                                      className={`designer-key${isPrimary ? " selected" : ""}`}
                                      aria-label={`${column.name} primary key`}
                                      aria-pressed={isPrimary}
                                      disabled={!editable}
                                      title="Primary key"
                                      onClick={() =>
                                        changeProps(
                                          column.name,
                                          isPrimary
                                            ? { primary: false }
                                            : { primary: true, not_null: true },
                                        )
                                      }
                                    >
                                      <KeyRound size={14} />
                                    </button>
                                  </td>
                                  <td className="structure-field-comment">
                                    <input
                                      aria-label={`${column.name} comment`}
                                      value={
                                        patch.comment ?? detail?.comment ?? ""
                                      }
                                      readOnly={!editable}
                                      onChange={(event) =>
                                        changeProps(column.name, {
                                          comment: event.target.value,
                                        })
                                      }
                                    />
                                  </td>
                                </tr>
                              );
                            })}
                          </tbody>
                        </table>
                        {!visible.length && (
                          <div className="designer-empty">
                            <Columns3 size={24} />
                            <strong>
                              {search
                                ? "No matching fields"
                                : "No fields found"}
                            </strong>
                            <span>
                              {search
                                ? "Try another name or data type."
                                : "Refresh to reload the structure."}
                            </span>
                          </div>
                        )}
                      </div>
                      <div className="structure-grid-hint">
                        Edit fields, then Save to apply
                        <span>↑ ↓ Navigate fields</span>
                      </div>
                    </div>
                    <aside
                      className="structure-inspector structure-properties-bottom"
                      aria-label="Selected field properties"
                    >
                      <div className="structure-inspector-caption">
                        <Columns3 size={14} />
                        Field properties{" "}
                        {field && (
                          <h3>{names.get(field.name) ?? field.name}</h3>
                        )}
                      </div>
                      {field ? (
                        <FieldPropertyEditor
                          column={field}
                          detail={fieldDetail}
                          patch={fieldPatch}
                          enabled={propertiesSupported && !!fieldDetail}
                          busy={busy}
                          onChange={(patch) => changeProps(field.name, patch)}
                        />
                      ) : (
                        <p className="structure-muted">
                          Select a field to see its properties.
                        </p>
                      )}
                      {fieldIndexes.length > 0 && (
                        <div className="structure-field-indexes">
                          Indexes:{" "}
                          {fieldIndexes.map((index) => (
                            <span key={index.name}>
                              <KeyRound size={12} />
                              {index.name}
                            </span>
                          ))}
                        </div>
                      )}
                      <p className="structure-property-hint">
                        {propertiesSupported
                          ? "Edit fields above and their properties here, then Save to apply."
                          : "Field names can be edited here. Use SQL Editor for other field properties on this database."}
                      </p>
                    </aside>
                  </div>
                )}
                {pane === "Indexes" && (
                  <div className="designer-section structure-indexes">
                    <div className="designer-section-heading">
                      <div>
                        <h3>Indexes & keys</h3>
                        <p>Field order is shown as defined in the database.</p>
                      </div>
                    </div>
                    {data.indexes.length ? (
                      data.indexes.map((index) => (
                        <article
                          className="structure-index-card"
                          key={index.name}
                        >
                          <KeyRound size={18} />
                          <div>
                            <h4>{index.name}</h4>
                            <div className="structure-index-fields">
                              {index.columns.map((column, order) => (
                                <span key={`${column}-${order}`}>
                                  <small>{order + 1}</small>
                                  {column}
                                </span>
                              ))}
                            </div>
                          </div>
                          <span
                            className={
                              index.primary
                                ? "structure-primary"
                                : "structure-index-kind"
                            }
                          >
                            {index.primary
                              ? "PRIMARY KEY"
                              : index.unique
                                ? "UNIQUE"
                                : "INDEX"}
                          </span>
                        </article>
                      ))
                    ) : (
                      <div className="designer-empty">
                        <ListTree size={28} />
                        <strong>No indexes found</strong>
                        <span>
                          Indexes and keys will appear here after they are
                          created.
                        </span>
                      </div>
                    )}
                  </div>
                )}
                {pane === "Foreign Keys" &&
                  definitions("Foreign Keys", data.details.foreignKeys)}
                {pane === "Triggers" &&
                  definitions("Triggers", data.details.triggers)}
                {pane === "Checks" &&
                  definitions("Checks", data.details.checks)}
                {pane === "Options" && (
                  <div className="designer-section structure-options">
                    <div className="designer-section-heading">
                      <div>
                        <h3>Table options</h3>
                        <p>Storage and database settings for this table.</p>
                      </div>
                    </div>
                    {data.details.unavailable.includes("Options") ? (
                      <p className="structure-muted">
                        Options metadata is unavailable. Check SQL Preview.
                      </p>
                    ) : (
                      <div className="structure-options-form">
                        {Object.entries(data.details.options).map(
                          ([name, value]) => (
                            <label key={name}>
                              {name.replaceAll("_", " ")}
                              {name === "definition" ? (
                                <textarea
                                  aria-label={name}
                                  readOnly
                                  value={value ?? "Database default"}
                                  rows={6}
                                />
                              ) : (
                                <input
                                  aria-label={`Table option ${name}`}
                                  readOnly
                                  value={value ?? "Database default"}
                                />
                              )}
                            </label>
                          ),
                        )}
                      </div>
                    )}
                  </div>
                )}
                {pane === "Comment" && (
                  <div className="designer-section structure-comment">
                    <div className="designer-section-heading">
                      <div>
                        <h3>Table comment</h3>
                        <p>Description stored with this table.</p>
                      </div>
                    </div>
                    <label>
                      Description
                      <textarea
                        aria-label="Table comment"
                        readOnly
                        rows={8}
                        value={data.details.comment ?? ""}
                        placeholder={
                          session.config.driver === "sqlite"
                            ? "SQLite does not store table comments separately. See SQL Preview."
                            : data.details.unavailable.includes("Options")
                              ? "Comment metadata is unavailable."
                              : "No table comment"
                        }
                      />
                    </label>
                  </div>
                )}
                {pane === "SQL Preview" && (
                  <div className="designer-section designer-sql structure-sql">
                    <div className="designer-section-heading">
                      <div>
                        <h3>SQL definition</h3>
                        <p>
                          {dirty
                            ? "Pending ALTER statements. Changes run only when you Save."
                            : "Current definition returned by the database."}
                        </p>
                      </div>
                      <button
                        className="button secondary"
                        disabled={
                          !!error ||
                          (dirty &&
                            (!previewSql ||
                              previewBusy ||
                              !!validation ||
                              !!previewError))
                        }
                        onClick={() => void copySql()}
                      >
                        {copied ? <Check size={14} /> : <Copy size={14} />}
                        {copied ? "Copied" : "Copy SQL"}
                      </button>
                    </div>
                    {copyError && (
                      <p role="alert" className="designer-error">
                        {copyError}
                      </p>
                    )}
                    {previewError && (
                      <p className="designer-error" role="alert">
                        {previewError}
                      </p>
                    )}
                    <pre aria-label="Table definition SQL" tabIndex={0}>
                      {dirty
                        ? validation ||
                          (previewBusy
                            ? "Preparing ALTER TABLE preview…"
                            : previewError ||
                              previewSql ||
                              `-- Pending field changes. Save to apply.\n${renames.map((rename) => `-- ${JSON.stringify(rename.from)} → ${JSON.stringify(rename.to)}`).join("\n")}\n\n${data.ddl}`)
                        : data.ddl}
                    </pre>
                  </div>
                )}
              </>
            )
          )}
        </div>
        {(validation || saveError) && (
          <div className="designer-error" role="alert">
            {validation || saveError}
          </div>
        )}
        {success && (
          <div
            className="structure-save-success"
            role="status"
            {...successEvents}
          >
            <Check size={14} />
            {success}
          </div>
        )}
        <footer
          className={`designer-footer structure-footer${discard ? " structure-discard" : ""}`}
        >
          {discard ? (
            <>
              <span role="status">Discard unsaved field changes?</span>
              <button
                className="button secondary"
                onClick={() => setDiscard(null)}
              >
                Keep editing
              </button>
              <button
                className="button danger"
                onClick={() => {
                  const action = discard;
                  setNames(new Map());
                  setPatches(new Map());
                  setDiscard(null);
                  setSaveError("");
                  if (action === "close") onClose();
                  else refresh((current) => current + 1);
                }}
              >
                Discard changes
              </button>
            </>
          ) : (
            <>
              <span>
                {data
                  ? `${data.columns.length} fields · ${data.indexes.length} indexes`
                  : "Table structure"}
                <span> · </span>
                {changes.length
                  ? `${changes.length} unsaved field change(s)`
                  : "Edit a field to get started."}
              </span>
              <button
                className="button secondary"
                disabled={busy}
                onClick={() => dismiss()}
              >
                Close
              </button>
              <button
                className="button secondary"
                disabled={!data || loading || busy || !!error || dirty}
                onClick={edit}
              >
                <Code2 size={15} />
                SQL Editor
              </button>
              {!isView && (
                <button
                  className="button primary"
                  disabled={!data || loading || busy || !!validation || !dirty}
                  onClick={() => void save()}
                  title="Save field changes (⌘/Ctrl+S)"
                >
                  {busy ? (
                    <Loader2 size={15} className="spin" />
                  ) : (
                    <Save size={15} />
                  )}
                  {busy ? "Saving…" : "Save"}
                </button>
              )}
            </>
          )}
        </footer>
      </section>
    </div>
  );
}
