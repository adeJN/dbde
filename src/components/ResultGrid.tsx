import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import { useVirtualizer } from "@tanstack/react-virtual";
import {
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type RowSelectionState,
  type SortingState,
} from "@tanstack/react-table";
import {
  ArrowDownUp,
  Search,
  Download,
  Table2,
  CheckCircle2,
  Copy,
  Trash2,
  X,
  Loader2,
  AlertTriangle,
  Filter,
  Plus,
  ArrowUp,
  ArrowDown,
  ChevronRight,
} from "lucide-react";
import type { QueryResult, TableFilter, TableSort } from "../types";
import { csvCell, displayValue } from "../lib/sql";
import { rowKeys, rowsAsTsv } from "../lib/rows";
import Pagination from "./Pagination";
import TableFilters from "./TableFilters";
import RecordEditor from "./RecordEditor";
import NewRecordRow from "./NewRecordRow";

async function writeClipboard(text: string) {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return;
    }
  } catch {
    /* Try native WebView fallback below. */
  }
  const focused = document.activeElement as HTMLElement | null;
  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.style.cssText = "position:fixed;left:-9999px;top:0";
  document.body.appendChild(textarea);
  textarea.select();
  try {
    if (!document.execCommand("copy"))
      throw new Error(
        "Clipboard access was denied. Allow clipboard access and try again.",
      );
  } finally {
    textarea.remove();
    focused?.focus();
  }
}
export default function ResultGrid({
  result,
  busy = false,
  onDelete,
  onPageChange,
  onFilterApply,
  onSortChange,
  onResetView,
  onUpdateCell,
  onInsertRecord,
  onRefresh,
}: {
  result: QueryResult;
  busy?: boolean;
  onDelete?: (rows: unknown[][]) => Promise<void>;
  onPageChange?: (page: number, pageSize: number) => void;
  onFilterApply?: (filters: TableFilter[]) => void;
  onSortChange?: (sort?: TableSort) => void;
  onResetView?: () => void;
  onUpdateCell?: (
    row: unknown[],
    column: string,
    value: string | null,
  ) => Promise<number>;
  onInsertRecord?: (values: Record<string, string | null>) => Promise<number>;
  onRefresh?: () => void;
}) {
  const [filter, setFilter] = useState("");
  const [localPage, setLocalPage] = useState(1);
  const [localPageSize, setLocalPageSize] = useState(1000);
  const [sorting, setSorting] = useState<SortingState>([]);
  const [rowSelection, setRowSelection] = useState<RowSelectionState>({});
  const [message, setMessage] = useState("");
  const [error, setError] = useState("");
  const [confirmRows, setConfirmRows] = useState<unknown[][] | null>(null);
  const [deleting, setDeleting] = useState(false);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const [recordTarget, setRecordTarget] = useState<{
    row: unknown[];
    column: string;
    index: number;
    draftValue?: string;
  } | null>(null);
  const [addingRecord, setAddingRecord] = useState(false);
  const [activeCell, setActiveCell] = useState({ row: 0, column: 0 });
  const focusRequest = useRef<{ row: number; column: number } | null>(null);
  const [context, setContext] = useState<{
    x: number;
    y: number;
    row: unknown[];
    column: string;
    index: number;
    submenu?: "copy" | "filter" | "sort";
  } | null>(null);
  const [confirmedKeys, setConfirmedKeys] = useState<Record<string, unknown>[]>(
    [],
  );
  const scroll = useRef<HTMLDivElement>(null);
  useEffect(() => {
    setRowSelection({});
    setLocalPage(1);
    setContext(null);
    setRecordTarget(null);
    setAddingRecord(false);
    setActiveCell({ row: 0, column: 0 });
    focusRequest.current = null;
    if (scroll.current) scroll.current.scrollTop = 0;
  }, [result]);
  useEffect(() => {
    if (!context) return;
    const close = () => setContext(null);
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") close();
    };
    document.addEventListener("pointerdown", close);
    document.addEventListener("keydown", closeOnEscape);
    window.addEventListener("scroll", close, true);
    return () => {
      document.removeEventListener("pointerdown", close);
      document.removeEventListener("keydown", closeOnEscape);
      window.removeEventListener("scroll", close, true);
    };
  }, [context]);
  useEffect(() => {
    if (context)
      document
        .querySelector<HTMLButtonElement>(
          ".grid-context-menu button:not(:disabled)",
        )
        ?.focus();
  }, [context?.row]);
  const data = useMemo(() => {
    const indexed = result.rows.map((values, index) => ({ values, index }));
    return filter
      ? indexed.filter((row) =>
          row.values.some((v) =>
            displayValue(v).toLowerCase().includes(filter.toLowerCase()),
          ),
        )
      : indexed;
  }, [result, filter]);
  const columns = useMemo(
    () =>
      result.columns.map((name, index) => ({
        id: String(index),
        header: name,
        accessorFn: (row: { values: unknown[] }) => row.values[index],
      })),
    [result.columns],
  );
  const table = useReactTable({
    data,
    columns,
    getRowId: (row) => String(row.index),
    enableRowSelection: true,
    state: { sorting, rowSelection },
    onSortingChange: setSorting,
    onRowSelectionChange: setRowSelection,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
  });
  const serverPaging = !!result.pagination && !!result.source && !!onPageChange;
  const allRows = table.getRowModel().rows;
  const pageSize = serverPaging ? result.pagination!.page_size : localPageSize;
  const totalRows = serverPaging
    ? result.pagination!.total_rows
    : allRows.length;
  const page = serverPaging
    ? result.pagination!.page
    : Math.min(localPage, Math.max(1, Math.ceil(totalRows / pageSize)));
  const rows = serverPaging
    ? allRows
    : allRows.slice((page - 1) * pageSize, page * pageSize);
  function changePage(nextPage: number, nextSize: number) {
    setRowSelection({});
    setMessage("");
    setError("");
    if (scroll.current) scroll.current.scrollTop = 0;
    if (serverPaging) onPageChange!(nextPage, nextSize);
    else {
      setLocalPage(nextPage);
      setLocalPageSize(nextSize);
    }
  }
  const selected = rows
    .filter((row) => row.getIsSelected())
    .map((row) => row.original.values);
  const virtual = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scroll.current,
    estimateSize: () => 37,
    overscan: 12,
  });
  const locked = busy || deleting;
  const canMutate = !!result.source && result.source.table.kind === "table";
  const canAddInline =
    canMutate && !!onInsertRecord && result.columns.length > 0;
  const lastGridRow = rows.length - 1 + (canAddInline ? 1 : 0);
  function focusGridCell(row: number, column: number) {
    const target = { row, column };
    focusRequest.current = target;
    setActiveCell(target);
    if (canAddInline && row === rows.length) {
      if (scroll.current)
        scroll.current.scrollTop = scroll.current.scrollHeight;
    } else {
      virtual.scrollToIndex?.(row, { align: "auto" });
    }
  }
  useEffect(() => {
    const target = focusRequest.current;
    if (!target) return;
    let attempts = 0;
    const focus = () => {
      if (focusRequest.current !== target) return;
      const cell = scroll.current?.querySelector<HTMLElement>(
        `[data-grid-row="${target.row}"][data-grid-col="${target.column}"]`,
      );
      if (cell) {
        cell.focus({ preventScroll: true });
        focusRequest.current = null;
      } else if (attempts++ < 4) {
        window.setTimeout(focus, 16);
      }
    };
    focus();
  });
  function navigateGrid(
    event: ReactKeyboardEvent<HTMLElement>,
    row: number,
    column: number,
  ) {
    if (event.altKey || (event.metaKey && !["Home", "End"].includes(event.key)))
      return false;
    let nextRow = row;
    let nextColumn = column;
    switch (event.key) {
      case "ArrowLeft":
        nextColumn = Math.max(0, column - 1);
        break;
      case "ArrowRight":
        nextColumn = Math.min(result.columns.length - 1, column + 1);
        break;
      case "ArrowUp":
        nextRow = Math.max(0, row - 1);
        break;
      case "ArrowDown":
        nextRow = Math.min(lastGridRow, row + 1);
        break;
      case "Home":
        if (event.ctrlKey || event.metaKey) nextRow = 0;
        nextColumn = 0;
        break;
      case "End":
        if (event.ctrlKey || event.metaKey) nextRow = lastGridRow;
        nextColumn = result.columns.length - 1;
        break;
      case "Tab":
        if (event.shiftKey) {
          if (row === 0 && column === 0) return false;
          nextRow = column === 0 ? row - 1 : row;
          nextColumn = column === 0 ? result.columns.length - 1 : column - 1;
        } else {
          if (row === lastGridRow && column === result.columns.length - 1)
            return false;
          nextRow = column === result.columns.length - 1 ? row + 1 : row;
          nextColumn = column === result.columns.length - 1 ? 0 : column + 1;
        }
        break;
      default:
        return false;
    }
    event.preventDefault();
    focusGridCell(nextRow, nextColumn);
    return true;
  }
  const deleteReason = !result.source
    ? "Open a table from Explorer to delete rows. Custom query results are read-only."
    : !result.source.primary_keys.length
      ? "This table has no primary key. Delete rows using an explicit SQL query."
      : !onDelete
        ? "Row deletion is unavailable."
        : selected.length > 1000
          ? "Select at most 1,000 rows per deletion."
          : "";
  async function copyRows() {
    setError("");
    setMessage("");
    try {
      await writeClipboard(rowsAsTsv(result.columns, selected));
      setMessage(
        `${selected.length} row${selected.length === 1 ? "" : "s"} copied with headers.`,
      );
    } catch (e) {
      setError(String(e));
    }
  }
  async function copyContext(format: "tsv" | "csv" | "json") {
    if (!context) return;
    const row = context.row;
    const text =
      format === "tsv"
        ? rowsAsTsv(result.columns, [row])
        : format === "csv"
          ? [result.columns, row]
              .map((values) => values.map(csvCell).join(","))
              .join("\r\n")
          : JSON.stringify(
              Object.fromEntries(
                result.columns.map((column, i) => [column, row[i]]),
              ),
              null,
              2,
            );
    setContext(null);
    try {
      await writeClipboard(text);
      setMessage("Record copied.");
      setError("");
    } catch (cause) {
      setError(String(cause));
    }
  }
  function sortColumn(column: string, direction?: "asc" | "desc") {
    if (!onSortChange || !result.source) return;
    onSortChange(direction ? { column, direction } : undefined);
    setContext(null);
  }
  function askDeleteContext() {
    if (!context) return;
    try {
      setConfirmedKeys(rowKeys(result, [context.row]));
      setConfirmRows([context.row]);
      setError("");
    } catch (cause) {
      setError(String(cause));
    }
    setContext(null);
  }
  async function pasteContext() {
    if (!context || !navigator.clipboard?.readText) {
      setError("Clipboard reading is unavailable.");
      return;
    }
    const target = context;
    setContext(null);
    try {
      const value = await navigator.clipboard.readText();
      setRecordTarget({
        row: target.row,
        column: target.column,
        index: target.index,
        draftValue: value,
      });
    } catch (cause) {
      setError(String(cause));
    }
  }
  function askDelete() {
    setError("");
    setMessage("");
    try {
      setConfirmedKeys(rowKeys(result, selected));
      setConfirmRows(selected);
    } catch (e) {
      setError(String(e));
    }
  }
  async function confirmDelete() {
    if (!confirmRows || !onDelete || deleting) return;
    setDeleting(true);
    setError("");
    try {
      const count = confirmRows.length;
      await onDelete(confirmRows);
      setConfirmRows(null);
      setRowSelection({});
      setMessage(`${count} row${count === 1 ? "" : "s"} deleted.`);
    } catch (e) {
      setError(String(e));
    } finally {
      setDeleting(false);
    }
  }
  function exportCsv() {
    const blob = new Blob(
      [
        "\uFEFF" +
          [result.columns, ...rows.map((r) => r.original.values)]
            .map((r) => r.map(csvCell).join(","))
            .join("\r\n"),
      ],
      { type: "text/csv;charset=utf-8" },
    );
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = "dbde-results.csv";
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  const template = `34px 48px repeat(${result.columns.length}, minmax(160px, 1fr))`;
  return (
    <div className="results">
      <div className="result-toolbar">
        <span className="result-label">
          <Table2 size={15} /> {result.source?.table.name ?? "Results"}{" "}
          <span className="count">
            {(
              result.pagination?.total_rows ?? result.rows.length
            ).toLocaleString()}
          </span>
        </span>
        <span
          className="selection-count"
          aria-live="polite"
          hidden={!selected.length}
        >
          {selected.length ? `${selected.length} selected` : ""}
        </span>
        <div className="spacer" />
        {canMutate && onInsertRecord && (
          <button
            className="button row-action"
            aria-label="Add record"
            title="Add a record"
            disabled={locked}
            onClick={() => setAddingRecord(true)}
          >
            <Plus size={15} />
          </button>
        )}
        <div className="row-actions">
          {result.source && onFilterApply && (
            <button
              className={`button row-action icon-only filter-action ${result.source.filters?.length ? "active" : ""}`}
              aria-label="Filters"
              aria-expanded={filtersOpen}
              aria-controls="table-filter-builder"
              title={`Filter table rows${result.source.filters?.length ? ` (${result.source.filters.length} active)` : ""}`}
              onClick={() => setFiltersOpen((open) => !open)}
            >
              <Filter size={15} />
            </button>
          )}
          <button
            className="button row-action icon-only"
            aria-label="Copy selected rows"
            title="Copy selected rows with column headers (tab-separated)"
            onClick={() => void copyRows()}
            disabled={!selected.length || locked}
          >
            <Copy size={15} />
          </button>
          <button
            className="button row-action icon-only danger"
            aria-label="Delete selected rows"
            title={deleteReason || "Delete selected rows from the database"}
            onClick={askDelete}
            disabled={!selected.length || locked || !!deleteReason}
          >
            <Trash2 size={15} />
          </button>
        </div>
        <label className="search small">
          <Search size={14} />
          <input
            aria-label="Filter results"
            placeholder={serverPaging ? "Filter this page…" : "Filter results…"}
            value={filter}
            disabled={locked}
            onChange={(e) => {
              setFilter(e.target.value);
              setLocalPage(1);
              setRowSelection({});
              setMessage("");
              if (scroll.current) scroll.current.scrollTop = 0;
            }}
          />
        </label>
        <button
          className="button subtle"
          onClick={exportCsv}
          disabled={!result.columns.length}
          title="Export rows on this page as CSV"
        >
          <Download size={14} /> Export CSV
        </button>
      </div>
      {result.source && onFilterApply && filtersOpen && (
        <TableFilters
          columns={result.columns}
          applied={result.source.filters ?? []}
          busy={locked}
          onApply={onFilterApply}
          onClose={() => setFiltersOpen(false)}
          sort={result.source.sort}
          onSortChange={onSortChange}
        />
      )}
      {(message || (error && !confirmRows)) && (
        <div
          className={`row-message ${error ? "error" : "success"}`}
          role={error ? "alert" : "status"}
        >
          {error || message}
          <button
            className="icon-button"
            aria-label="Dismiss row action message"
            onClick={() => {
              setError("");
              setMessage("");
            }}
          >
            <X size={13} />
          </button>
        </div>
      )}
      {!!result.columns.length && (
        <div className="row-action-hint">
          {deleteReason || (
            <>
              Table{" "}
              <strong>
                {result.source!.database ? result.source!.database + "." : ""}
                {result.source!.table.schema &&
                result.source!.table.schema !== result.source!.database
                  ? result.source!.table.schema + "."
                  : ""}
                {result.source!.table.name}
              </strong>{" "}
              · Primary key: {result.source!.primary_keys.join(", ")}
            </>
          )}
          <span id="grid-keyboard-help" className="grid-keyboard-help">
            {" · "}Arrow keys navigate · Enter opens a cell
            {canAddInline && " · Type in the bottom row · Ctrl/⌘+Enter saves"}
          </span>
        </div>
      )}
      {result.columns.length ? (
        <div
          className="grid-scroll"
          ref={scroll}
          role="table"
          aria-label="Query results"
          aria-describedby="grid-keyboard-help"
          aria-rowcount={rows.length + 1 + Number(canAddInline)}
        >
          <div
            className="grid-head"
            role="row"
            style={{ gridTemplateColumns: template }}
          >
            <span className="selection-cell">
              <input
                type="checkbox"
                aria-label="Select all rows on this page"
                checked={rows.length > 0 && selected.length === rows.length}
                ref={(element) => {
                  if (element)
                    element.indeterminate =
                      selected.length > 0 && selected.length < rows.length;
                }}
                onChange={(e) =>
                  setRowSelection(
                    e.target.checked
                      ? Object.fromEntries(rows.map((row) => [row.id, true]))
                      : {},
                  )
                }
                disabled={locked || !rows.length}
              />
            </span>
            <span>#</span>
            {table.getFlatHeaders().map((h) => (
              <button
                role="columnheader"
                title={
                  serverPaging
                    ? "Sort all rows by this column"
                    : "Sort fetched results"
                }
                key={h.id}
                onClick={
                  result.source && onSortChange
                    ? () => {
                        const column = String(h.column.columnDef.header);
                        const current = result.source?.sort;
                        sortColumn(
                          column,
                          current?.column !== column
                            ? "asc"
                            : current.direction === "asc"
                              ? "desc"
                              : undefined,
                        );
                      }
                    : h.column.getToggleSortingHandler()
                }
              >
                {String(h.column.columnDef.header)}
                {result.source?.sort?.column === h.column.columnDef.header ? (
                  result.source?.sort?.direction === "asc" ? (
                    <ArrowUp size={12} />
                  ) : (
                    <ArrowDown size={12} />
                  )
                ) : (
                  <ArrowDownUp size={11} />
                )}
              </button>
            ))}
          </div>
          <div
            style={{
              height: virtual.getTotalSize(),
              position: "relative",
              minWidth: 82 + result.columns.length * 160,
            }}
          >
            {virtual.getVirtualItems().map((item) => {
              const row = rows[item.index];
              return (
                <div
                  className={`grid-row ${row.getIsSelected() ? "selected" : ""}`}
                  role="row"
                  aria-rowindex={item.index + 2}
                  aria-selected={row.getIsSelected()}
                  key={row.id}
                  style={{
                    gridTemplateColumns: template,
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <span className="selection-cell">
                    <input
                      type="checkbox"
                      aria-label={`Select row ${row.original.index + 1}`}
                      checked={row.getIsSelected()}
                      onChange={row.getToggleSelectedHandler()}
                      disabled={locked}
                    />
                  </span>
                  <span className="row-number">
                    {(page - 1) * pageSize + item.index + 1}
                  </span>
                  {row.original.values.map((value, i) => (
                    <span
                      role="cell"
                      tabIndex={
                        activeCell.row === item.index && activeCell.column === i
                          ? 0
                          : -1
                      }
                      data-grid-row={item.index}
                      data-grid-col={i}
                      key={i}
                      onFocus={() =>
                        setActiveCell({ row: item.index, column: i })
                      }
                      onClick={(event) => event.currentTarget.focus()}
                      onDoubleClick={() =>
                        setRecordTarget({
                          row: row.original.values,
                          column: result.columns[i],
                          index: i,
                        })
                      }
                      onKeyDown={(event) => {
                        if (navigateGrid(event, item.index, i)) return;
                        if (event.key === "Enter" || event.key === "F2") {
                          event.preventDefault();
                          setRecordTarget({
                            row: row.original.values,
                            column: result.columns[i],
                            index: i,
                          });
                        }
                        if (
                          event.key === "ContextMenu" ||
                          (event.shiftKey && event.key === "F10")
                        ) {
                          event.preventDefault();
                          const rect =
                            event.currentTarget.getBoundingClientRect();
                          setContext({
                            x: Math.min(rect.left, window.innerWidth - 230),
                            y: Math.min(rect.bottom, window.innerHeight - 420),
                            row: row.original.values,
                            column: result.columns[i],
                            index: i,
                          });
                        }
                      }}
                      onContextMenu={(event) => {
                        event.preventDefault();
                        setContext({
                          x: Math.min(event.clientX, window.innerWidth - 230),
                          y: Math.min(event.clientY, window.innerHeight - 420),
                          row: row.original.values,
                          column: result.columns[i],
                          index: i,
                        });
                      }}
                      className={
                        value == null
                          ? "null"
                          : typeof value === "number"
                            ? "number"
                            : ""
                      }
                      title={displayValue(value)}
                    >
                      {displayValue(value)}
                    </span>
                  ))}
                </div>
              );
            })}
          </div>
          {!rows.length && (
            <div className="empty-inline">No rows match this result.</div>
          )}
          {canAddInline && (
            <NewRecordRow
              columns={result.columns}
              template={template}
              rowIndex={rows.length}
              activeColumn={
                activeCell.row === rows.length ? activeCell.column : null
              }
              busy={locked}
              onFocusCell={(column) =>
                setActiveCell({ row: rows.length, column })
              }
              onCellKeyDown={(event, column) =>
                navigateGrid(event, rows.length, column)
              }
              onSave={onInsertRecord!}
            />
          )}
        </div>
      ) : (
        <div className="empty">
          <CheckCircle2 size={30} />
          <h3>Query completed</h3>
          <p>{result.affected_rows.toLocaleString()} rows affected.</p>
        </div>
      )}
      {!!result.columns.length && (
        <Pagination
          page={page}
          pageSize={pageSize}
          totalRows={totalRows}
          rowCount={serverPaging ? result.rows.length : rows.length}
          busy={locked}
          onChange={changePage}
        />
      )}
      <div className="result-footer">
        <span>
          <span className="dot" /> {busy ? "Loading page…" : "Query successful"}
        </span>
        <span>
          {rows.length.toLocaleString()} rows
          {filter ? " matching on this page" : " on this page"} <i>·</i>{" "}
          {result.execution_ms.toFixed(1)} ms
          {result.truncated && " · Result limited to 50,000 rows"}
        </span>
      </div>
      {(recordTarget || addingRecord) && (
        <RecordEditor
          key={recordTarget ? "edit" : "new"}
          columns={result.columns}
          primaryKeys={result.source?.primary_keys ?? []}
          target={recordTarget ?? undefined}
          canEdit={canMutate && !!result.source?.primary_keys.length}
          canInsert={canMutate}
          onUpdate={onUpdateCell}
          onInsert={onInsertRecord}
          onClose={() => {
            setRecordTarget(null);
            setAddingRecord(false);
          }}
        />
      )}
      {context && (
        <div
          className="grid-context-menu"
          role="menu"
          style={{ left: Math.max(8, context.x), top: Math.max(8, context.y) }}
          onPointerDown={(event) => event.stopPropagation()}
        >
          <button
            role="menuitem"
            disabled={
              !canMutate ||
              !onDelete ||
              !result.source?.primary_keys.length ||
              locked
            }
            onClick={askDeleteContext}
          >
            Delete Record
          </button>
          <button role="menuitem" onClick={() => void copyContext("tsv")}>
            Copy
          </button>
          <button
            role="menuitem"
            onClick={() =>
              setContext({
                ...context,
                submenu: context.submenu === "copy" ? undefined : "copy",
              })
            }
          >
            Copy As <ChevronRight size={13} />
          </button>
          {context.submenu === "copy" && (
            <div className="grid-context-submenu">
              <button role="menuitem" onClick={() => void copyContext("tsv")}>
                TSV
              </button>
              <button role="menuitem" onClick={() => void copyContext("csv")}>
                CSV
              </button>
              <button role="menuitem" onClick={() => void copyContext("json")}>
                JSON
              </button>
            </div>
          )}
          <button
            role="menuitem"
            disabled={
              !canMutate ||
              !onUpdateCell ||
              !result.source?.primary_keys.length ||
              result.source.primary_keys.includes(context.column) ||
              locked
            }
            onClick={() => void pasteContext()}
          >
            Paste
          </button>
          <button
            role="menuitem"
            onClick={() => {
              exportCsv();
              setContext(null);
            }}
          >
            Save Data As…
          </button>
          <div className="context-separator" />
          <button
            role="menuitem"
            disabled={!result.source || !onFilterApply}
            onClick={() => {
              setFiltersOpen((open) => !open);
              setContext(null);
            }}
          >
            Show/Hide Filter &amp; Sort
          </button>
          <button
            role="menuitem"
            disabled={!result.source || !onFilterApply}
            onClick={() =>
              setContext({
                ...context,
                submenu: context.submenu === "filter" ? undefined : "filter",
              })
            }
          >
            Filter <ChevronRight size={13} />
          </button>
          {context.submenu === "filter" && (
            <div className="grid-context-submenu">
              <button
                role="menuitem"
                disabled={(result.source?.filters?.length ?? 0) >= 10 || locked}
                onClick={() => {
                  onFilterApply?.([
                    ...(result.source?.filters ?? []),
                    {
                      column: context.column,
                      operator:
                        context.row[context.index] == null
                          ? "is_null"
                          : "equals",
                      value:
                        context.row[context.index] == null
                          ? ""
                          : String(context.row[context.index]),
                    },
                  ]);
                  setContext(null);
                }}
              >
                Equals this value
              </button>
              <button
                role="menuitem"
                disabled={
                  context.row[context.index] == null ||
                  (result.source?.filters?.length ?? 0) >= 10 ||
                  locked
                }
                onClick={() => {
                  onFilterApply?.([
                    ...(result.source?.filters ?? []),
                    {
                      column: context.column,
                      operator: "contains",
                      value: String(context.row[context.index]),
                    },
                  ]);
                  setContext(null);
                }}
              >
                Contains this value
              </button>
            </div>
          )}
          <button
            role="menuitem"
            disabled={!result.source || !onSortChange}
            onClick={() =>
              setContext({
                ...context,
                submenu: context.submenu === "sort" ? undefined : "sort",
              })
            }
          >
            Sort <ChevronRight size={13} />
          </button>
          {context.submenu === "sort" && (
            <div className="grid-context-submenu">
              <button
                role="menuitem"
                onClick={() => sortColumn(context.column, "asc")}
              >
                Ascending
              </button>
              <button
                role="menuitem"
                onClick={() => sortColumn(context.column, "desc")}
              >
                Descending
              </button>
            </div>
          )}
          <button
            role="menuitem"
            disabled={
              !result.source ||
              !onResetView ||
              (!result.source.filters?.length && !result.source.sort)
            }
            onClick={() => {
              onResetView?.();
              setContext(null);
            }}
          >
            Remove All Filters &amp; Sorts
          </button>
          <div className="context-separator" />
          <button
            role="menuitem"
            disabled={!onRefresh || locked}
            onClick={() => {
              onRefresh?.();
              setContext(null);
            }}
          >
            Refresh
          </button>
        </div>
      )}
      {confirmRows && (
        <div
          className="modal-backdrop"
          onClick={(e) => {
            if (e.target === e.currentTarget && !deleting) setConfirmRows(null);
          }}
        >
          <section
            className="modal delete-dialog"
            onKeyDown={(e) => {
              if (e.key === "Escape" && !deleting) setConfirmRows(null);
            }}
            role="dialog"
            aria-modal="true"
            aria-labelledby="delete-rows-title"
          >
            <header>
              <div className="modal-icon destructive">
                <AlertTriangle size={23} />
              </div>
              <button
                className="icon-button"
                aria-label="Cancel row deletion"
                disabled={deleting}
                onClick={() => setConfirmRows(null)}
              >
                <X size={18} />
              </button>
            </header>
            <h2 id="delete-rows-title">
              Delete {confirmRows.length} row
              {confirmRows.length === 1 ? "" : "s"}?
            </h2>
            <p>
              This permanently removes the selected rows from{" "}
              <strong>
                {result.source?.database} /{" "}
                {result.source?.table.schema
                  ? result.source.table.schema + "."
                  : ""}
                {result.source?.table.name}
              </strong>
              . Related rows may also be affected by database cascades or
              triggers.
            </p>
            <div className="delete-preview">
              {confirmedKeys.slice(0, 3).map((key, i) => (
                <code key={i}>
                  {Object.entries(key)
                    .map(
                      ([column, value]) => `${column}: ${displayValue(value)}`,
                    )
                    .join(" · ")}
                </code>
              ))}
              {confirmRows.length > 3 && (
                <small>and {confirmRows.length - 3} more selected rows</small>
              )}
            </div>
            {error && (
              <div className="form-message error" role="alert">
                {error}
              </div>
            )}
            <footer>
              <button
                className="button secondary"
                autoFocus
                disabled={deleting}
                onClick={() => setConfirmRows(null)}
              >
                Cancel
              </button>
              <button
                className="button destructive"
                disabled={deleting || busy}
                onClick={() => void confirmDelete()}
              >
                {deleting ? (
                  <Loader2 size={14} className="spin" />
                ) : (
                  <Trash2 size={14} />
                )}{" "}
                {deleting
                  ? "Deleting…"
                  : `Delete ${confirmRows.length} row${confirmRows.length === 1 ? "" : "s"}`}
              </button>
            </footer>
          </section>
        </div>
      )}
    </div>
  );
}
