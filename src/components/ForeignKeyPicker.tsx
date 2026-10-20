import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import { ArrowDown, ArrowUp, Link2, Loader2, Search, X } from "lucide-react";
import type {
  ForeignKeyInfo,
  QueryResult,
  TableFilter,
  TableSort,
} from "../types";
import { viewTable } from "../lib/api";
import { displayValue } from "../lib/sql";

const PAGE_SIZE = 1000;
/** Search runs on the server over at most this many shown columns (filter limit). */
const MAX_SEARCH_COLUMNS = 10;
const EXTRA_COLUMNS = 3;
const SEARCH_DELAY = 250;
const isBinary = (value: unknown) =>
  value !== null && typeof value === "object" && "hex" in value;

/**
 * Foreign Key Data Selection (Navicat): lists rows of the referenced table so the user
 * can pick the key instead of typing it. Search is a server-side filter (bound values)
 * over the shown columns; rows load 1,000 at a time. Picking returns one value per
 * referencing column, so composite keys set every column of the key at once.
 */
export default function ForeignKeyPicker({
  connectionId,
  database,
  foreignKey,
  current,
  onPick,
  onClose,
  sourceSchema = "",
}: {
  /** Schema of the referencing table; other schemas are shown in the title. */
  sourceSchema?: string;
  connectionId: string;
  /** Database that holds the referenced table. */
  database: string;
  foreignKey: ForeignKeyInfo;
  /** Current values of the referencing columns, to highlight the matching row. */
  current: Record<string, unknown>;
  onPick: (values: Record<string, string | null>) => void;
  onClose: () => void;
}) {
  const id = useId();
  const searchInput = useRef<HTMLInputElement>(null);
  const [search, setSearch] = useState("");
  const [applied, setApplied] = useState("");
  const [sort, setSort] = useState<TableSort | undefined>();
  const [columns, setColumns] = useState<string[]>([]);
  const [rows, setRows] = useState<unknown[][]>([]);
  const [page, setPage] = useState(1);
  const [total, setTotal] = useState(0);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [active, setActive] = useState(0);
  const [extra, setExtra] = useState<string[] | null>(null);
  const request = useRef(0);
  const keys = foreignKey.referenced_columns;
  const shown = [...keys, ...(extra ?? [])];
  const table = foreignKey.referenced_table;

  async function load(
    nextPage: number,
    text: string,
    order: TableSort | undefined,
    append: boolean,
  ) {
    const ticket = ++request.current;
    setLoading(true);
    setError("");
    const filters: TableFilter[] = text
      ? shown.slice(0, MAX_SEARCH_COLUMNS).map((column, index) => ({
          join: index ? "or" : "and",
          column,
          operator: "contains",
          value: text,
        }))
      : [];
    try {
      const result: QueryResult = await viewTable(
        connectionId,
        database,
        table,
        nextPage,
        PAGE_SIZE,
        filters,
        order,
      );
      if (ticket !== request.current) return;
      setColumns(result.columns);
      if (extra === null)
        setExtra(
          result.columns
            .filter((column) => !keys.includes(column))
            .slice(0, EXTRA_COLUMNS),
        );
      setRows((before) => (append ? [...before, ...result.rows] : result.rows));
      setPage(result.pagination?.page ?? nextPage);
      setTotal(result.pagination?.total_rows ?? result.rows.length);
      if (!append) {
        const match = result.rows.findIndex((row) =>
          foreignKey.columns.every((column, index) => {
            const position = result.columns.indexOf(keys[index]);
            const value = current[column];
            return (
              value != null &&
              position >= 0 &&
              displayValue(row[position]) === displayValue(value)
            );
          }),
        );
        setActive(Math.max(0, match));
      }
    } catch (cause) {
      if (ticket === request.current) setError(String(cause));
    } finally {
      if (ticket === request.current) setLoading(false);
    }
  }
  useEffect(() => {
    void load(1, "", undefined, false);
    searchInput.current?.focus();
    return () => {
      request.current++;
    };
  }, []);
  // Typing searches after a short pause; Enter searches right away.
  useEffect(() => {
    if (search === applied) return;
    const timer = window.setTimeout(() => runSearch(search), SEARCH_DELAY);
    return () => window.clearTimeout(timer);
  }, [search]);
  function runSearch(text: string) {
    setApplied(text);
    void load(1, text, sort, false);
  }
  function toggleSort(column: string) {
    const next: TableSort | undefined =
      sort?.column !== column
        ? { column, direction: "asc" }
        : sort.direction === "asc"
          ? { column, direction: "desc" }
          : undefined;
    setSort(next);
    void load(1, applied, next, false);
  }
  const valueAt = (row: unknown[], column: string) =>
    row[columns.indexOf(column)];
  function pick(index: number) {
    const row = rows[index];
    if (!row) return;
    const values = keys.map((column) => valueAt(row, column));
    if (values.some(isBinary)) {
      setError("Binary key values cannot be selected here.");
      return;
    }
    onPick(
      Object.fromEntries(
        foreignKey.columns.map((column, i) => [
          column,
          values[i] == null ? null : displayValue(values[i]),
        ]),
      ),
    );
  }
  function keyDown(event: KeyboardEvent<HTMLElement>) {
    const last = rows.length - 1;
    const go = (index: number) => {
      event.preventDefault();
      const next = Math.max(0, Math.min(last, index));
      setActive(next);
      document
        .getElementById(`${id}-row-${next}`)
        ?.scrollIntoView?.({ block: "nearest" });
    };
    if (event.key === "ArrowDown") return go(active + 1);
    if (event.key === "ArrowUp") return go(active - 1);
    if (event.key === "PageDown") return go(active + 10);
    if (event.key === "PageUp") return go(active - 10);
    if (event.key === "Enter") {
      event.preventDefault();
      if (event.currentTarget === searchInput.current && search !== applied)
        runSearch(search);
      else pick(active);
    }
  }
  const label = `${table.schema && table.schema !== sourceSchema ? `${table.schema}.` : ""}${table.name}`;
  const candidates = columns.filter((column) => !keys.includes(column));
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="modal fk-picker"
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${id}-title`}
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header>
          <div className="modal-icon">
            <Link2 size={20} />
          </div>
          <button
            className="icon-button"
            aria-label="Close foreign key selection"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <h2 id={`${id}-title`}>Select from {label}</h2>
        <p>
          Sets{" "}
          {foreignKey.columns
            .map((column, i) => `${column} ← ${keys[i]}`)
            .join(", ")}
          . Double-click a row or press Enter to choose it.
        </p>
        <div className="fk-picker-tools">
          <label className="fk-picker-search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchInput}
              type="search"
              aria-label={`Search ${label}`}
              placeholder="Search shown columns"
              value={search}
              aria-controls={`${id}-rows`}
              aria-activedescendant={
                rows.length ? `${id}-row-${active}` : undefined
              }
              onChange={(event) => setSearch(event.target.value)}
              onKeyDown={keyDown}
            />
          </label>
          <details className="fk-picker-columns">
            <summary>Display columns</summary>
            <fieldset>
              <legend>Extra columns to show</legend>
              {candidates.map((column) => (
                <label key={column}>
                  <input
                    type="checkbox"
                    checked={!!extra?.includes(column)}
                    onChange={(event) =>
                      setExtra((before) =>
                        event.target.checked
                          ? candidates.filter(
                              (name) =>
                                name === column || before?.includes(name),
                            )
                          : (before ?? []).filter((name) => name !== column),
                      )
                    }
                  />
                  {column}
                </label>
              ))}
            </fieldset>
          </details>
        </div>
        {error && (
          <div className="form-message error" role="alert">
            {error}
          </div>
        )}
        <div className="fk-picker-rows">
          <table
            id={`${id}-rows`}
            role="grid"
            aria-label={`Rows of ${label}`}
            aria-rowcount={total + 1}
            tabIndex={0}
            aria-activedescendant={
              rows.length ? `${id}-row-${active}` : undefined
            }
            onKeyDown={keyDown}
          >
            <thead>
              <tr>
                {shown.map((column) => (
                  <th
                    key={column}
                    aria-sort={
                      sort?.column === column
                        ? sort.direction === "asc"
                          ? "ascending"
                          : "descending"
                        : "none"
                    }
                  >
                    <button
                      type="button"
                      className={keys.includes(column) ? "key" : undefined}
                      title={`Sort by ${column}`}
                      onClick={() => toggleSort(column)}
                    >
                      {column}
                      {sort?.column === column &&
                        (sort.direction === "asc" ? (
                          <ArrowUp size={12} />
                        ) : (
                          <ArrowDown size={12} />
                        ))}
                    </button>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => (
                <tr
                  key={index}
                  id={`${id}-row-${index}`}
                  aria-selected={index === active}
                  className={index === active ? "active" : undefined}
                  onClick={() => setActive(index)}
                  onDoubleClick={() => pick(index)}
                >
                  {shown.map((column) => {
                    const value = valueAt(row, column);
                    return (
                      <td
                        key={column}
                        className={value == null ? "null" : undefined}
                      >
                        {displayValue(value)}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
          {!loading && !rows.length && !error && (
            <div className="empty-inline">
              {applied ? "No rows match the search." : "The table is empty."}
            </div>
          )}
        </div>
        <footer className="fk-picker-footer">
          <span role="status" aria-live="polite">
            {loading ? (
              <>
                <Loader2 size={13} className="spin" /> Loading…
              </>
            ) : (
              `${rows.length.toLocaleString()} of ${total.toLocaleString()} rows`
            )}
          </span>
          {!loading && rows.length < total && (
            <button
              type="button"
              className="button subtle"
              onClick={() => void load(page + 1, applied, sort, true)}
            >
              Show more
            </button>
          )}
          <span className="spacer" />
          <button type="button" className="button secondary" onClick={onClose}>
            Cancel
          </button>
          <button
            type="button"
            className="button primary"
            disabled={!rows.length}
            onClick={() => pick(active)}
          >
            Select
          </button>
        </footer>
      </section>
    </div>
  );
}
