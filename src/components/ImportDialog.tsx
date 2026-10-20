import { useEffect, useMemo, useRef, useState } from "react";
import { FileUp, Loader2, Upload, X } from "lucide-react";
import type { Driver, TableInfo } from "../types";
import type { ConfirmRequest } from "./ConfirmDialog";
import * as api from "../lib/api";
import {
  IMPORT_FORMATS,
  IMPORT_MODES,
  MAX_IMPORT_ROWS,
  SKIP,
  autoMapping,
  formatBytes,
  importSummaryText,
  mappedColumns,
  mappingError,
  parseOptionsError,
  unmappedRequired,
  type ImportFormat,
  type ImportMode,
  type ImportParseOptions,
  type ImportPreview,
  type ImportSummary,
  type ImportTarget,
} from "../lib/import";

export interface ImportDialogRequest {
  connectionId: string;
  database: string;
  driver: Driver;
  table: TableInfo;
}
type Step = "source" | "mapping" | "options";
const STEPS: { value: Step; label: string }[] = [
  { value: "source", label: "1. Source file" },
  { value: "mapping", label: "2. Column mapping" },
  { value: "options", label: "3. Import" },
];
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
const NULL_MARKERS = [
  { value: "", label: "Empty cell" },
  { value: "NULL", label: "NULL" },
  { value: "\\N", label: "\\N" },
];
const count = (n: number, word: string) =>
  `${n.toLocaleString()} ${word}${n === 1 ? "" : "s"}`;

export default function ImportDialog({
  request,
  confirm,
  prepare,
  onImported,
  onClose,
}: {
  request: ImportDialogRequest;
  /** The app's confirmation dialog, used before Copy deletes every row. */
  confirm: (request: ConfirmRequest) => Promise<boolean>;
  /** Resolves pending grid edits and open transactions on this table; false cancels. */
  prepare: () => Promise<boolean>;
  /** Called after a successful import so open tabs can refresh. */
  onImported: (summary: ImportSummary) => void;
  onClose: () => void;
}) {
  const { table } = request;
  const root = useRef<HTMLElement>(null);
  const [step, setStep] = useState<Step>("source");
  const [target, setTarget] = useState<ImportTarget | null>(null);
  const [preview, setPreview] = useState<ImportPreview | null>(null);
  const [options, setOptions] = useState<ImportParseOptions | null>(null);
  const [mapping, setMapping] = useState<Record<string, string>>({});
  const [mode, setMode] = useState<ImportMode>("append");
  const [continueOnError, setContinueOnError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [running, setRunning] = useState(false);
  const [progress, setProgress] = useState(0);
  const [summary, setSummary] = useState<ImportSummary | null>(null);
  const [failure, setFailure] = useState("");
  const [info, setInfo] = useState("");
  const importId = useRef("");
  const runId = useRef(0);
  const parseRun = useRef(0);
  const name = `${table.schema && table.schema !== request.database ? table.schema + "." : ""}${table.name}`;

  useEffect(() => {
    let live = true;
    api
      .importTarget(request.connectionId, request.database, table)
      .then((info) => live && setTarget(info))
      .catch((cause) => live && setFailure(String(cause)));
    return () => {
      live = false;
    };
  }, [request.connectionId, request.database, table]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    root.current?.querySelector<HTMLButtonElement>(".import-choose")?.focus();
    return () => {
      if (importId.current) void api.closeImport(importId.current);
      if (previous?.isConnected) previous.focus();
    };
  }, []);

  // A file chosen before the table columns arrived is matched once they do.
  useEffect(() => {
    if (target && preview) setMapping((current) => remap(preview, current));
  }, [target]);
  function remap(next: ImportPreview, previous: Record<string, string>) {
    if (!target) return {};
    const auto = autoMapping(next.columns, target);
    return Object.fromEntries(
      next.columns.map((source) => [
        source,
        source in previous ? previous[source] : auto[source],
      ]),
    );
  }
  async function choose() {
    if (busy || running) return;
    setBusy(true);
    setFailure("");
    setInfo("");
    try {
      const opened = await api.openImportFile();
      if (!opened) return;
      if (importId.current && importId.current !== opened.import_id)
        void api.closeImport(importId.current);
      importId.current = opened.import_id;
      setPreview(opened);
      setOptions(opened.options);
      setMapping(remap(opened, {}));
      setSummary(null);
    } catch (cause) {
      setFailure(String(cause));
    } finally {
      setBusy(false);
    }
  }
  async function reparse(patch: Partial<ImportParseOptions>) {
    if (!preview || !options) return;
    const next = { ...options, ...patch };
    setOptions(next);
    setFailure("");
    setInfo("");
    const problem = parseOptionsError(next);
    if (problem) return setFailure(problem);
    const run = ++parseRun.current;
    setBusy(true);
    try {
      const parsed = await api.previewImport(preview.import_id, next);
      if (run !== parseRun.current) return;
      setPreview(parsed);
      setOptions(parsed.options);
      setMapping((current) => remap(parsed, current));
    } catch (cause) {
      if (run === parseRun.current) setFailure(String(cause));
    } finally {
      if (run === parseRun.current) setBusy(false);
    }
  }

  const mapped = useMemo(
    () => (preview ? mappedColumns(preview.columns, mapping) : []),
    [preview, mapping],
  );
  const required = target ? unmappedRequired(target, mapped, mode) : [];
  const sourceProblem = !target
    ? failure
      ? failure
      : "Loading table columns…"
    : !preview
      ? "Choose a file to import."
      : options && parseOptionsError(options)
        ? parseOptionsError(options)
        : !preview.columns.length
          ? "No columns were found in the file."
          : "";
  const mapProblem =
    sourceProblem ||
    (target ? mappingError(target, mapped, mode, continueOnError) : "");
  const problem =
    mapProblem ||
    (required.length
      ? `Map the required column${required.length === 1 ? "" : "s"} ${required.join(", ")} (NOT NULL without a default).`
      : "") ||
    (options?.format === "excel" && !api.desktop
      ? "Excel import requires the desktop app."
      : "");

  async function run() {
    if (problem || running || !preview || !options || !target) return;
    setFailure("");
    setInfo("");
    if (mode === "copy") {
      let rows: number;
      try {
        rows = await api.importRowCount(
          request.connectionId,
          request.database,
          table,
        );
      } catch (cause) {
        return setFailure(String(cause));
      }
      const confirmed = await confirm({
        title: `Replace every row in ${table.name}?`,
        body: `Copy deletes ${count(rows, "existing row")} in ${request.database ? request.database + "." : ""}${name} and then imports ${preview.file_name}. If the import fails or is cancelled, the deletion is rolled back.`,
        confirmLabel: "Delete rows and import",
        details: [`${name}: ${count(rows, "row")} will be deleted`],
      });
      if (!confirmed) return;
    }
    try {
      if (!(await prepare())) {
        setInfo(
          "Import cancelled. Unsaved changes and open transactions were kept.",
        );
        return;
      }
    } catch (cause) {
      return setFailure(String(cause));
    }
    const id = ++runId.current;
    setRunning(true);
    setProgress(0);
    try {
      const result = await api.runImport(
        request.connectionId,
        request.database,
        table,
        preview.import_id,
        {
          options,
          mapping: mapped,
          mode,
          continue_on_error: continueOnError,
          batch_rows: 500,
        },
        setProgress,
      );
      if (runId.current !== id) return;
      if (result) {
        setSummary(result);
        onImported(result);
      } else setInfo("Import cancelled. Nothing was imported.");
    } catch (cause) {
      if (runId.current === id) setFailure(String(cause));
    } finally {
      if (runId.current === id) setRunning(false);
    }
  }
  function cancel() {
    if (running) void api.cancelImport(importId.current);
    else onClose();
  }
  const targetColumn = (column: string) =>
    target?.columns.find((c) => c.name === column);
  const sample = (index: number) => {
    const value = preview?.rows.find((row) => row[index] !== null)?.[index];
    return value === undefined ? "" : (value ?? "");
  };
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
        disabled={disabled || running || busy}
        onChange={onSelect}
      />
      <span>{label}</span>
    </label>
  );
  const format = options?.format;
  const delimited = format === "csv" || format === "tsv";
  const stepIndex = STEPS.findIndex((s) => s.value === step);
  const canAdvance = step === "source" ? !sourceProblem : !mapProblem;
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !running) onClose();
      }}
    >
      <section
        ref={root}
        className="modal export-dialog import-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="import-title"
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
          <div className="modal-icon">
            <Upload size={20} />
          </div>
          <button
            className="icon-button"
            aria-label="Close import"
            disabled={running}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <h2 id="import-title">
          Import into {name}
          <small>
            {request.database ? `${request.database} · ` : ""}
            {target ? count(target.columns.length, "column") : "Loading…"}
            {target?.primary_keys.length
              ? ` · primary key ${target.primary_keys.join(", ")}`
              : target
                ? " · no primary key"
                : ""}
          </small>
        </h2>
        {!summary && (
          <nav className="import-steps" aria-label="Import steps">
            {STEPS.map((s, i) => (
              <button
                key={s.value}
                type="button"
                className={s.value === step ? "active" : ""}
                aria-current={s.value === step ? "step" : undefined}
                disabled={
                  running ||
                  (i > stepIndex &&
                    !!(i === 1 ? sourceProblem : sourceProblem || mapProblem))
                }
                onClick={() => setStep(s.value)}
              >
                {s.label}
              </button>
            ))}
          </nav>
        )}
        {summary ? (
          <ImportResult summary={summary} />
        ) : step === "source" ? (
          <>
            <fieldset className="export-section">
              <legend>File</legend>
              <div className="import-file">
                <button
                  type="button"
                  className="button secondary import-choose"
                  disabled={busy || running}
                  onClick={() => void choose()}
                >
                  <FileUp size={14} />{" "}
                  {preview ? "Choose another file…" : "Choose file…"}
                </button>
                {preview && (
                  <span className="import-file-name" title={preview.file_name}>
                    {preview.file_name} · {formatBytes(preview.file_size)} ·{" "}
                    {preview.exact_rows ? "" : "about "}
                    {count(preview.estimated_rows, "row")}
                  </span>
                )}
              </div>
              <small className="export-hint">
                CSV, TSV, JSON (an array of objects), JSON Lines
                {api.desktop ? " or Excel (.xlsx, .xls)" : ""}, encoded as UTF-8
                with or without BOM. At most{" "}
                {api.desktop ? "512 MB" : "64 MB in the browser sandbox"} and{" "}
                {MAX_IMPORT_ROWS.toLocaleString()} rows.
              </small>
            </fieldset>
            {preview && options && (
              <fieldset className="export-section">
                <legend>Format</legend>
                <div className="export-formats">
                  {IMPORT_FORMATS.map((f) =>
                    radio(
                      "import-format",
                      f.value,
                      f.label,
                      format === f.value,
                      () =>
                        void reparse({
                          format: f.value as ImportFormat,
                          delimiter: f.value === "tsv" ? "\t" : ",",
                          sheet: undefined,
                        }),
                      f.value === "excel" && !api.desktop,
                      f.value === "excel" && !api.desktop
                        ? "Excel import requires the desktop app"
                        : undefined,
                    ),
                  )}
                </div>
                {delimited && (
                  <div className="form-row">
                    {format === "csv" && (
                      <label>
                        Delimiter
                        <select
                          value={options.delimiter}
                          disabled={busy || running}
                          onChange={(e) =>
                            void reparse({ delimiter: e.target.value })
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
                        disabled={busy || running}
                        onChange={(e) =>
                          void reparse({ quote: e.target.value })
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
                {format === "excel" && (
                  <label>
                    Sheet
                    <select
                      value={options.sheet ?? ""}
                      disabled={busy || running}
                      onChange={(e) => void reparse({ sheet: e.target.value })}
                    >
                      {preview.sheets.map((sheet) => (
                        <option key={sheet} value={sheet}>
                          {sheet}
                        </option>
                      ))}
                    </select>
                  </label>
                )}
                {(delimited || format === "excel") && (
                  <>
                    <label className="export-choice">
                      <input
                        type="checkbox"
                        checked={options.header}
                        disabled={busy || running}
                        onChange={(e) =>
                          void reparse({ header: e.target.checked })
                        }
                      />
                      <span>First row contains column names</span>
                    </label>
                    <div className="form-row">
                      <label>
                        NULL marker
                        <select
                          value={
                            NULL_MARKERS.some(
                              (m) => m.value === options.null_text,
                            )
                              ? options.null_text
                              : "custom"
                          }
                          disabled={busy || running}
                          onChange={(e) =>
                            void reparse({
                              null_text:
                                e.target.value === "custom"
                                  ? "NULL"
                                  : e.target.value,
                            })
                          }
                        >
                          {NULL_MARKERS.map((m) => (
                            <option key={m.label} value={m.value}>
                              {m.label}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                    <small className="export-hint">
                      {options.null_text
                        ? `Cells containing exactly ${options.null_text} become NULL; empty cells stay empty strings.`
                        : "Empty cells become NULL."}{" "}
                      Numbers and dates are passed as text and converted by the
                      database.
                    </small>
                  </>
                )}
                {(format === "json" || format === "jsonl") && (
                  <small className="export-hint">
                    JSON null becomes NULL and missing keys are NULL. Nested
                    objects and arrays are imported as JSON text.
                  </small>
                )}
              </fieldset>
            )}
            {preview && (
              <fieldset className="export-section">
                <legend>
                  Preview
                  <span className="import-legend-note">
                    {count(preview.rows.length, "row")} ·{" "}
                    {count(preview.columns.length, "column")}
                  </span>
                </legend>
                <div
                  className="import-preview"
                  tabIndex={0}
                  aria-label="File preview"
                >
                  <table>
                    <thead>
                      <tr>
                        {preview.columns.map((column) => (
                          <th key={column}>{column}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody>
                      {preview.rows.map((row, r) => (
                        <tr key={r}>
                          {row.map((value, c) => (
                            <td
                              key={c}
                              className={value === null ? "null" : ""}
                            >
                              {value ?? "NULL"}
                            </td>
                          ))}
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
                {preview.row_errors.length > 0 && (
                  <small className="export-hint import-warning">
                    {preview.row_errors
                      .slice(0, 3)
                      .map((e) => `Row ${e.row}: ${e.message}`)
                      .join(" ")}
                  </small>
                )}
              </fieldset>
            )}
          </>
        ) : step === "mapping" && preview && target ? (
          <fieldset className="export-section">
            <legend>
              Map source columns to {table.name}
              <span className="export-legend-actions">
                <button
                  type="button"
                  className="link-button"
                  disabled={running}
                  onClick={() =>
                    setMapping(autoMapping(preview.columns, target))
                  }
                >
                  Match by name
                </button>
                <button
                  type="button"
                  className="link-button"
                  disabled={running}
                  onClick={() =>
                    setMapping(
                      Object.fromEntries(preview.columns.map((c) => [c, SKIP])),
                    )
                  }
                >
                  Skip all
                </button>
              </span>
            </legend>
            <div
              className="import-mapping"
              role="table"
              aria-label="Column mapping"
            >
              <div role="row" className="import-mapping-head">
                <span role="columnheader">Source</span>
                <span role="columnheader">Target column</span>
                <span role="columnheader">Type</span>
              </div>
              {preview.columns.map((source, i) => {
                const chosen = targetColumn(mapping[source] ?? SKIP);
                return (
                  <div role="row" key={source}>
                    <span
                      role="cell"
                      className="import-source"
                      title={sample(i)}
                    >
                      {source}
                      <small>{sample(i)}</small>
                    </span>
                    <span role="cell">
                      <select
                        aria-label={`Target for ${source}`}
                        value={mapping[source] ?? SKIP}
                        disabled={running}
                        onChange={(e) =>
                          setMapping((current) => ({
                            ...current,
                            [source]: e.target.value,
                          }))
                        }
                      >
                        <option value={SKIP}>Skip</option>
                        {target.columns.map((c) => (
                          <option
                            key={c.name}
                            value={c.name}
                            disabled={c.generated}
                          >
                            {c.name}
                            {target.primary_keys.includes(c.name)
                              ? " (key)"
                              : ""}
                            {c.generated ? " (generated)" : ""}
                          </option>
                        ))}
                      </select>
                    </span>
                    <span role="cell" className="import-type">
                      {chosen
                        ? `${chosen.data_type || "any"}${chosen.nullable ? "" : " · NOT NULL"}`
                        : "—"}
                    </span>
                  </div>
                );
              })}
            </div>
            {required.length > 0 && (
              <div className="form-message error import-required" role="alert">
                Required column{required.length === 1 ? "" : "s"} not mapped
                (NOT NULL without a default): {required.join(", ")}
              </div>
            )}
          </fieldset>
        ) : step === "options" && target ? (
          <>
            <fieldset className="export-section">
              <legend>Import mode</legend>
              {IMPORT_MODES.map((m) => {
                const needsKey =
                  (m.value === "update" || m.value === "upsert") &&
                  !target.primary_keys.length;
                const needsTransaction =
                  m.value === "copy" && !target.transactional;
                return (
                  <label key={m.value} className="export-choice import-mode">
                    <input
                      type="radio"
                      name="import-mode"
                      value={m.value}
                      checked={mode === m.value}
                      disabled={running || needsKey || needsTransaction}
                      onChange={() => setMode(m.value)}
                    />
                    <span>
                      {m.label}
                      <small>
                        {needsKey
                          ? "Requires a primary key."
                          : needsTransaction
                            ? "Requires a transactional (InnoDB) table."
                            : m.description}
                      </small>
                    </span>
                  </label>
                );
              })}
            </fieldset>
            <fieldset className="export-section">
              <legend>Errors</legend>
              <label className="export-choice">
                <input
                  type="checkbox"
                  checked={continueOnError}
                  disabled={running}
                  onChange={(e) => setContinueOnError(e.target.checked)}
                />
                <span>
                  Continue on error (skip rejected rows and report them)
                </span>
              </label>
              <small className="export-hint">
                {!target.transactional
                  ? "This table's storage engine cannot roll back, so rows are written one by one and stay written even if the import is cancelled."
                  : continueOnError
                    ? "Rows the database rejects are skipped; all other rows are imported."
                    : "The whole import runs in one transaction: if any row fails or you cancel, nothing is imported."}
              </small>
            </fieldset>
            {preview && (
              <small className="export-hint">
                {count(mapped.length, "column")} from {preview.file_name} into{" "}
                {name}, {preview.exact_rows ? "" : "about "}
                {count(preview.estimated_rows, "row")}.
              </small>
            )}
          </>
        ) : null}
        {running && (
          <div className="export-progress" role="status">
            <Loader2 size={14} className="spin" /> Importing…{" "}
            {count(progress, "row")} processed
            {preview
              ? ` of ${preview.exact_rows ? "" : "about "}${preview.estimated_rows.toLocaleString()}`
              : ""}
          </div>
        )}
        {busy && !running && (
          <div className="export-progress" role="status">
            <Loader2 size={14} className="spin" /> Reading file…
          </div>
        )}
        {!running && info && (
          <div className="form-message" role="status">
            {info}
          </div>
        )}
        {!running && failure && (
          <div className="form-message error" role="alert">
            {failure}
          </div>
        )}
        {!running && !failure && !summary && step === "options" && problem && (
          <div className="form-message error" role="alert">
            {problem}
          </div>
        )}
        <footer>
          {summary ? (
            <button type="button" className="button primary" onClick={onClose}>
              Close
            </button>
          ) : (
            <>
              <button
                type="button"
                className="button secondary"
                onClick={cancel}
              >
                {running ? "Cancel import" : "Cancel"}
              </button>
              {stepIndex > 0 && (
                <button
                  type="button"
                  className="button secondary"
                  disabled={running}
                  onClick={() => setStep(STEPS[stepIndex - 1].value)}
                >
                  Back
                </button>
              )}
              {step !== "options" ? (
                <button
                  type="button"
                  className="button primary"
                  disabled={!canAdvance || running || busy}
                  title={step === "source" ? sourceProblem : mapProblem}
                  onClick={() => setStep(STEPS[stepIndex + 1].value)}
                >
                  Next
                </button>
              ) : (
                <button
                  type="button"
                  className="button primary"
                  disabled={!!problem || running || busy}
                  onClick={() => void run()}
                >
                  {running ? (
                    <Loader2 size={14} className="spin" />
                  ) : (
                    <Upload size={14} />
                  )}{" "}
                  Import
                </button>
              )}
            </>
          )}
        </footer>
      </section>
    </div>
  );
}

function ImportResult({ summary }: { summary: ImportSummary }) {
  const issues = summary.errors.length + summary.more_errors;
  return (
    <fieldset className="export-section import-summary">
      <legend>Summary</legend>
      <p role="status">{importSummaryText(summary)}</p>
      <dl>
        <dt>Rows read</dt>
        <dd>{summary.rows.toLocaleString()}</dd>
        {summary.deleted > 0 && (
          <>
            <dt>Deleted first</dt>
            <dd>{summary.deleted.toLocaleString()}</dd>
          </>
        )}
        <dt>Inserted</dt>
        <dd>{summary.inserted.toLocaleString()}</dd>
        <dt>Updated</dt>
        <dd>{summary.updated.toLocaleString()}</dd>
        <dt>Skipped</dt>
        <dd>{summary.skipped.toLocaleString()}</dd>
        <dt>Errors</dt>
        <dd>{summary.failed.toLocaleString()}</dd>
      </dl>
      {issues > 0 && (
        <div className="import-errors" tabIndex={0} aria-label="Row issues">
          <table>
            <thead>
              <tr>
                <th>Row</th>
                <th>Issue</th>
              </tr>
            </thead>
            <tbody>
              {summary.errors.map((issue, i) => (
                <tr key={i}>
                  <td>{issue.row.toLocaleString()}</td>
                  <td>{issue.message}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {summary.more_errors > 0 && (
            <small className="export-hint">
              …and {summary.more_errors.toLocaleString()} more not listed.
            </small>
          )}
        </div>
      )}
    </fieldset>
  );
}
