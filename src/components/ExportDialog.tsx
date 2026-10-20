import { useEffect, useMemo, useRef, useState } from "react";
import { Download, Loader2, X } from "lucide-react";
import type { Driver, TableFilter, TableInfo, TableSort } from "../types";
import * as api from "../lib/api";
import {
  EXPORT_FORMATS,
  MAX_FETCHED_EXPORT_ROWS,
  defaultExportOptions,
  exportOptionsError,
  type ExportFormat,
  type ExportOptions,
  type ExportScope,
  type ExportSummary,
} from "../lib/export";

/** What can be exported: a table (streamed by the backend) and/or rows the grid holds. */
export interface ExportRequest {
  connectionId: string;
  database: string;
  driver: Driver;
  /** Source table; whole-table and filtered exports read it from the database. */
  table?: TableInfo;
  columns: string[];
  /**
   * Columns ticked when the dialog opens (the grid's visible columns); every column
   * stays available to tick. All columns when absent.
   */
  initialColumns?: string[];
  /** The grid's current filters and sort, offered as a scope when present. */
  view?: { filters: TableFilter[]; sort?: TableSort };
  /** Ticked grid rows (full rows, one value per column). */
  selectedRows?: unknown[][];
  /** A query's fetched rows when there is no source table. */
  fetchedRows?: unknown[][];
}
const DELIMITERS = [
  { value: ",", label: "Comma ( , )" },
  { value: ";", label: "Semicolon ( ; )" },
  { value: "|", label: "Pipe ( | )" },
  { value: "\t", label: "Tab" },
];
const QUOTES = [
  { value: '"', label: 'Double quote ( " )' },
  { value: "'", label: "Single quote ( ' )" },
];
const hasDeferred = (rows: unknown[][]) =>
  rows.some((row) =>
    row.some(
      (value) =>
        value !== null && typeof value === "object" && "deferred" in value,
    ),
  );
const count = (n: number, word: string) =>
  `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

export default function ExportDialog({
  request,
  onDone,
  onClose,
}: {
  request: ExportRequest;
  onDone: (summary: ExportSummary) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const { table, view, selectedRows = [], fetchedRows } = request;
  const filtered = !!view && (view.filters.length > 0 || !!view.sort);
  const scopes = useMemo(() => {
    const list: { value: ExportScope; label: string; disabled?: string }[] = [];
    if (table) list.push({ value: "all", label: "All rows in the table" });
    if (table && filtered)
      list.push({
        value: "filtered",
        label: "Rows matching the current filter and sort",
      });
    if (!table && fetchedRows)
      list.push({
        value: "fetched",
        label: `All fetched rows (${fetchedRows.length.toLocaleString()})`,
        ...(fetchedRows.length > MAX_FETCHED_EXPORT_ROWS
          ? {
              disabled: `At most ${MAX_FETCHED_EXPORT_ROWS.toLocaleString()} fetched rows can be exported.`,
            }
          : {}),
      });
    if (selectedRows.length)
      list.push({
        value: "selected",
        label: `Selected rows (${selectedRows.length.toLocaleString()})`,
        ...(hasDeferred(selectedRows)
          ? {
              disabled:
                "Selected rows have values that Quick mode did not load; export the table instead.",
            }
          : {}),
      });
    return list;
  }, [table, filtered, fetchedRows, selectedRows]);
  const [scope, setScope] = useState<ExportScope>(
    () =>
      (
        scopes.find((s) => s.value === "selected" && !s.disabled) ??
        scopes.find((s) => s.value === "filtered") ??
        scopes[0]
      )?.value ?? "all",
  );
  const [options, setOptions] = useState<ExportOptions>(() =>
    defaultExportOptions(request.columns),
  );
  const [checked, setChecked] = useState(() =>
    request.columns.map(
      (column) =>
        !request.initialColumns || request.initialColumns.includes(column),
    ),
  );
  const [customNull, setCustomNull] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [failure, setFailure] = useState("");
  const [info, setInfo] = useState("");
  const exportId = useRef("");
  const update = (patch: Partial<ExportOptions>) => {
    setOptions((current) => ({ ...current, ...patch }));
    setFailure("");
    setInfo("");
  };
  const chosen = request.columns.filter((_, i) => checked[i]);
  const format = options.format;
  const delimited = format === "csv" || format === "tsv";
  const canCreate = !!table && table.kind !== "view";
  const effective: ExportOptions = {
    ...options,
    columns: chosen,
    null_text: customNull ? options.null_text : "",
    create_table: format === "sql" && canCreate && options.create_table,
    ...(format === "sql" && !table
      ? { table_name: options.table_name ?? "" }
      : { table_name: undefined }),
  };
  const scopeDisabled = scopes.find((s) => s.value === scope)?.disabled;
  const problem =
    exportOptionsError(effective) ||
    (format === "sql" && !table && !(options.table_name ?? "").trim()
      ? "Enter a table name for the INSERT statements."
      : "") ||
    (format === "xlsx" && !api.desktop
      ? "Excel export requires the desktop app. Choose CSV, TSV, JSON or SQL in the browser sandbox."
      : "") ||
    (scopeDisabled ?? "") ||
    (scopes.length ? "" : "Nothing to export.");
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current
      ?.querySelector<HTMLInputElement>("input[name='export-format']:checked")
      ?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  async function run() {
    if (problem || running) return;
    const id = crypto.randomUUID();
    exportId.current = id;
    setRunning(true);
    setProgress(0);
    setFailure("");
    setInfo("");
    try {
      let summary: ExportSummary | null;
      if (table && (scope === "all" || scope === "filtered"))
        summary = await api.exportTable(
          request.connectionId,
          request.database,
          table,
          effective,
          scope === "filtered" && view ? view : {},
          id,
          setProgress,
        );
      else {
        const indexes = checked.flatMap((on, i) => (on ? [i] : []));
        const source =
          scope === "selected" ? selectedRows : (fetchedRows ?? []);
        summary = await api.exportRows(
          request.connectionId,
          request.database || undefined,
          table,
          effective,
          source.map((row) => indexes.map((i) => row[i])),
          id,
          setProgress,
        );
      }
      if (exportId.current !== id) return;
      if (summary) onDone(summary);
      else {
        setRunning(false);
        setInfo("Export cancelled. No file was written.");
      }
    } catch (cause) {
      if (exportId.current !== id) return;
      setRunning(false);
      setFailure(String(cause));
    }
  }
  function cancel() {
    if (running) void api.cancelExport(exportId.current);
    else onClose();
  }
  const name = table
    ? `${table.schema && table.schema !== request.database ? table.schema + "." : ""}${table.name}`
    : "query results";
  const radio = (
    group: string,
    value: string,
    label: string,
    selected: boolean,
    onSelect: () => void,
    disabled = false,
    title?: string,
  ) => (
    <label key={value} className="export-choice" title={title}>
      <input
        type="radio"
        name={group}
        value={value}
        checked={selected}
        disabled={disabled || running}
        onChange={onSelect}
      />
      <span>{label}</span>
    </label>
  );
  const checkbox = (
    label: string,
    value: boolean,
    onChange: (value: boolean) => void,
    disabled = false,
  ) => (
    <label className="export-choice">
      <input
        type="checkbox"
        checked={value}
        disabled={disabled || running}
        onChange={(event) => onChange(event.target.checked)}
      />
      <span>{label}</span>
    </label>
  );
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !running) onClose();
      }}
    >
      <section
        ref={root}
        className="modal export-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="export-title"
        // The grid's own context menu must not open over the dialog.
        onContextMenu={(event) => event.stopPropagation()}
        onMouseDown={(event) => event.stopPropagation()}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            if (!running) onClose();
          }
          if (event.key === "Tab") {
            const nodes = root.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
            );
            if (!nodes?.length) return;
            const first = nodes[0];
            const last = nodes[nodes.length - 1];
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first.focus();
            }
          }
        }}
      >
        <header>
          <div className="export-heading">
            <div className="modal-icon">
              <Download size={18} />
            </div>
            <h2 id="export-title">
              Export {name}
              <small>
                {request.database ? `${request.database} · ` : ""}
                {count(chosen.length, "column")} of {request.columns.length}
              </small>
            </h2>
          </div>
          <button
            className="icon-button"
            aria-label="Close export"
            disabled={running}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void run();
          }}
        >
          <div className="export-form-body">
            <fieldset className="export-section">
              <legend>Format</legend>
              <div className="export-formats">
                {EXPORT_FORMATS.map((f) =>
                  radio(
                    "export-format",
                    f.value,
                    f.label,
                    format === f.value,
                    () => update({ format: f.value as ExportFormat }),
                    f.value === "xlsx" && !api.desktop,
                    f.value === "xlsx" && !api.desktop
                      ? "Excel export requires the desktop app"
                      : undefined,
                  ),
                )}
              </div>
            </fieldset>
            <fieldset className="export-section">
              <legend>Rows</legend>
              {scopes.map((s) =>
                radio(
                  "export-scope",
                  s.value,
                  s.label,
                  scope === s.value,
                  () => {
                    setScope(s.value);
                    setFailure("");
                  },
                  false,
                  s.disabled,
                ),
              )}
              {scopeDisabled && (
                <small className="export-hint">{scopeDisabled}</small>
              )}
            </fieldset>
            <fieldset className="export-section">
              <legend>
                Columns
                <span className="export-legend-actions">
                  <button
                    type="button"
                    className="link-button"
                    disabled={running}
                    onClick={() => setChecked(request.columns.map(() => true))}
                  >
                    All
                  </button>
                  <button
                    type="button"
                    className="link-button"
                    disabled={running}
                    onClick={() => setChecked(request.columns.map(() => false))}
                  >
                    None
                  </button>
                </span>
              </legend>
              <div
                className="export-columns"
                role="group"
                aria-label="Columns to export"
              >
                {request.columns.map((column, i) => (
                  <label key={`${i}:${column}`} className="export-choice">
                    <input
                      type="checkbox"
                      checked={checked[i]}
                      disabled={running}
                      onChange={(event) => {
                        const next = [...checked];
                        next[i] = event.target.checked;
                        setChecked(next);
                        setFailure("");
                      }}
                    />
                    <span title={column}>{column}</span>
                  </label>
                ))}
              </div>
            </fieldset>
            <fieldset className="export-section">
              <legend>Options</legend>
              {delimited && (
                <div className="form-row">
                  {format === "csv" && (
                    <label>
                      Delimiter
                      <select
                        value={options.delimiter}
                        disabled={running}
                        onChange={(event) =>
                          update({ delimiter: event.target.value })
                        }
                      >
                        {DELIMITERS.map((d) => (
                          <option key={d.label} value={d.value}>
                            {d.label}
                          </option>
                        ))}
                      </select>
                    </label>
                  )}
                  <label>
                    Quote character
                    <select
                      value={options.quote}
                      disabled={running}
                      onChange={(event) =>
                        update({ quote: event.target.value })
                      }
                    >
                      {QUOTES.map((q) => (
                        <option key={q.label} value={q.value}>
                          {q.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>
              )}
              {(delimited || format === "xlsx") && (
                <>
                  {checkbox(
                    "Header row with column names",
                    options.header,
                    (header) => update({ header }),
                  )}
                  <div className="form-row">
                    <label>
                      NULL values
                      <select
                        value={customNull ? "custom" : "empty"}
                        disabled={running}
                        onChange={(event) => {
                          setCustomNull(event.target.value === "custom");
                          if (
                            event.target.value === "custom" &&
                            !options.null_text
                          )
                            update({ null_text: "NULL" });
                        }}
                      >
                        <option value="empty">Empty cell</option>
                        <option value="custom">Custom text</option>
                      </select>
                    </label>
                    {customNull && (
                      <label>
                        NULL text
                        <input
                          value={options.null_text}
                          maxLength={64}
                          disabled={running}
                          spellCheck={false}
                          onChange={(event) =>
                            update({ null_text: event.target.value })
                          }
                        />
                      </label>
                    )}
                  </div>
                </>
              )}
              {delimited && (
                <>
                  {checkbox(
                    "Protect against spreadsheet formulas",
                    options.protect_formulas,
                    (protect_formulas) => update({ protect_formulas }),
                  )}
                  {checkbox("UTF-8 with BOM (for Excel)", options.bom, (bom) =>
                    update({ bom }),
                  )}
                </>
              )}
              {format === "sql" && (
                <>
                  {!table && (
                    <label>
                      Table name for INSERT
                      <input
                        value={options.table_name ?? ""}
                        disabled={running}
                        spellCheck={false}
                        placeholder="results"
                        onChange={(event) =>
                          update({ table_name: event.target.value })
                        }
                      />
                    </label>
                  )}
                  {checkbox(
                    "Include CREATE TABLE",
                    canCreate && options.create_table,
                    (create_table) => update({ create_table }),
                    !canCreate,
                  )}
                  <label>
                    Rows per INSERT
                    <input
                      type="number"
                      min={1}
                      max={1000}
                      value={
                        Number.isNaN(options.batch_size)
                          ? ""
                          : options.batch_size
                      }
                      disabled={running}
                      onChange={(event) =>
                        update({ batch_size: event.target.valueAsNumber })
                      }
                    />
                  </label>
                </>
              )}
              <small className="export-hint">
                {format === "json"
                  ? "An array of objects, one per row, with keys in column order. "
                  : format === "xlsx"
                    ? "Text is written as text cells, never formulas. Over 1,048,576 rows continue on a new sheet. "
                    : format === "sql"
                      ? `INSERT statements in the ${request.driver === "mysql" ? "MySQL" : request.driver === "postgres" ? "PostgreSQL" : "SQLite"} dialect. `
                      : "UTF-8. "}
                Dates and times are written as stored text; binary values as
                0x-prefixed hex.
              </small>
            </fieldset>
            {running && (
              <div className="export-progress" role="status">
                <Loader2 size={14} className="spin" /> Exporting…{" "}
                {count(progress, "row")} written
              </div>
            )}
            {!running && info && (
              <div className="form-message" role="status">
                {info}
              </div>
            )}
            {!running &&
              (failure || (problem && problem !== scopeDisabled)) && (
                <div className="form-message error" role="alert">
                  {failure || problem}
                </div>
              )}
          </div>
          <footer>
            <button type="button" className="button secondary" onClick={cancel}>
              {running ? "Cancel export" : "Cancel"}
            </button>
            <button className="button primary" disabled={!!problem || running}>
              {running ? (
                <Loader2 size={14} className="spin" />
              ) : (
                <Download size={14} />
              )}{" "}
              Export…
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
