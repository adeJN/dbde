import { useEffect, useState } from "react";
import { Plus, X } from "lucide-react";
import type { FilterOperator, TableFilter, TableSort } from "../types";
const operators: [FilterOperator, string][] = [
  ["equals", "Equals"],
  ["not_equals", "Does not equal"],
  ["contains", "Contains"],
  ["not_contains", "Does not contain"],
  ["starts_with", "Starts with"],
  ["ends_with", "Ends with"],
  ["is_null", "Is NULL"],
  ["is_not_null", "Is not NULL"],
];
export default function TableFilters({
  columns,
  applied,
  busy,
  onApply,
  onClose,
  sort,
  onSortChange,
}: {
  columns: string[];
  applied: TableFilter[];
  busy: boolean;
  onApply: (filters: TableFilter[]) => void;
  onClose: () => void;
  sort?: TableSort;
  onSortChange?: (sort?: TableSort) => void;
}) {
  const blank = (): TableFilter => ({
    column: columns[0] ?? "",
    operator: "contains",
    value: "",
  });
  const [draft, setDraft] = useState<TableFilter[]>(
    applied.length ? applied : [blank()],
  );
  const [sortColumn, setSortColumn] = useState(sort?.column ?? "");
  const [sortDirection, setSortDirection] = useState<TableSort["direction"]>(
    sort?.direction ?? "asc",
  );
  const appliedKey = JSON.stringify(applied);
  const columnsKey = JSON.stringify(columns);
  useEffect(() => {
    setDraft(applied.length ? applied : [blank()]);
  }, [appliedKey, columnsKey]);
  useEffect(() => {
    setSortColumn(sort?.column ?? "");
    setSortDirection(sort?.direction ?? "asc");
  }, [sort?.column, sort?.direction]);
  function change(index: number, patch: Partial<TableFilter>) {
    setDraft((rows) =>
      rows.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }
  return (
    <div className="table-filters">
      <form
        id="table-filter-builder"
        className="filter-builder"
        onSubmit={(e) => {
          e.preventDefault();
          if (!busy && draft.every((filter) => columns.includes(filter.column)))
            onApply(draft);
        }}
      >
        <fieldset disabled={busy}>
          <legend>Match all conditions (AND)</legend>
          {draft.map((filter, index) => (
            <div className="filter-condition" key={index}>
              <span>{index === 0 ? "Where" : "And"}</span>
              <select
                aria-label={`Filter column ${index + 1}`}
                value={filter.column}
                onChange={(e) => change(index, { column: e.target.value })}
              >
                {columns.map((column) => (
                  <option key={column} value={column}>
                    {column}
                  </option>
                ))}
              </select>
              <select
                aria-label={`Filter operator ${index + 1}`}
                value={filter.operator}
                onChange={(e) =>
                  change(index, {
                    operator: e.target.value as FilterOperator,
                  })
                }
              >
                {operators.map(([operator, label]) => (
                  <option key={operator} value={operator}>
                    {label}
                  </option>
                ))}
              </select>
              <input
                aria-label={`Filter value ${index + 1}`}
                placeholder={
                  filter.operator.startsWith("is_")
                    ? "No value required"
                    : "Value…"
                }
                disabled={filter.operator.startsWith("is_")}
                value={filter.value}
                onChange={(e) => change(index, { value: e.target.value })}
              />
              <button
                type="button"
                className="icon-button"
                aria-label={`Remove filter ${index + 1}`}
                disabled={busy || draft.length === 1}
                onClick={() =>
                  setDraft((rows) => rows.filter((_, i) => i !== index))
                }
              >
                <X size={14} />
              </button>
            </div>
          ))}
          <div className="filter-builder-actions">
            <button
              type="button"
              className="button subtle"
              disabled={draft.length >= 10}
              onClick={() => setDraft((rows) => [...rows, blank()])}
            >
              <Plus size={13} /> Add condition
            </button>
            <span>Text matching · % and _ are literal characters</span>
            {applied.length > 0 && (
              <button
                type="button"
                className="button subtle"
                onClick={() => {
                  setDraft([blank()]);
                  onApply([]);
                }}
              >
                <X size={12} /> Clear filters
              </button>
            )}
            <button
              type="button"
              className="button secondary"
              onClick={() => {
                setDraft(applied.length ? applied : [blank()]);
                onClose();
              }}
            >
              Cancel
            </button>
            <button
              className="button primary"
              disabled={!draft.length || !columns.length}
            >
              Apply filters
            </button>
          </div>
        </fieldset>
      </form>
      {onSortChange && (
        <div className="sort-controls">
          <label htmlFor="table-sort-column">Sort</label>
          <select
            id="table-sort-column"
            aria-label="Sort column"
            value={sortColumn}
            disabled={busy}
            onChange={(event) => setSortColumn(event.target.value)}
          >
            <option value="">No sort</option>
            {columns.map((column) => (
              <option key={column} value={column}>
                {column}
              </option>
            ))}
          </select>
          <select
            aria-label="Sort direction"
            value={sortDirection}
            disabled={busy || !sortColumn}
            onChange={(event) =>
              setSortDirection(event.target.value as TableSort["direction"])
            }
          >
            <option value="asc">Ascending</option>
            <option value="desc">Descending</option>
          </select>
          <button
            type="button"
            className="button secondary"
            disabled={
              busy ||
              (!!sort &&
                sort.column === sortColumn &&
                sort.direction === sortDirection) ||
              (!sort && !sortColumn)
            }
            onClick={() =>
              onSortChange(
                sortColumn
                  ? { column: sortColumn, direction: sortDirection }
                  : undefined,
              )
            }
          >
            Apply sort
          </button>
        </div>
      )}
    </div>
  );
}
