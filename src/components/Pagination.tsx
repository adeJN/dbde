import {
  ChevronLeft,
  ChevronRight,
  ChevronsLeft,
  ChevronsRight,
} from "lucide-react";
import { useEffect, useRef, useState } from "react";
export default function Pagination({
  page,
  pageSize,
  totalRows,
  rowCount,
  busy,
  onChange,
}: {
  page: number;
  pageSize: number;
  totalRows: number;
  rowCount: number;
  busy: boolean;
  onChange: (page: number, pageSize: number) => void;
}) {
  const [draft, setDraft] = useState(String(pageSize));
  const [error, setError] = useState("");
  const submitted = useRef<number>();
  useEffect(() => {
    if (!busy) {
      setDraft(String(pageSize));
      setError("");
      submitted.current = undefined;
    }
  }, [pageSize, busy]);
  function applySize() {
    if (busy) return;
    const value = Number(draft);
    if (
      !/^\d+$/.test(draft) ||
      !Number.isSafeInteger(value) ||
      value < 1 ||
      value > 5000
    ) {
      setError("Enter a whole number from 1 to 5,000.");
      return;
    }
    setError("");
    setDraft(String(value));
    if (value !== pageSize && submitted.current !== value) {
      submitted.current = value;
      onChange(1, value);
    }
  }
  const pages = Math.max(1, Math.ceil(totalRows / pageSize));
  const start = rowCount ? (page - 1) * pageSize + 1 : 0;
  const end = rowCount ? start + rowCount - 1 : 0;
  return (
    <nav className="pagination" aria-label="Table pagination">
      <span className="page-range" aria-live="polite">
        {start.toLocaleString()}–{end.toLocaleString()}{" "}
        <span>of {totalRows.toLocaleString()} rows</span>
      </span>
      <div className="pagination-controls">
        <label>
          Rows per page{" "}
          <input
            type="text"
            inputMode="numeric"
            pattern="[0-9]*"
            aria-label="Rows per page"
            aria-invalid={!!error}
            aria-describedby={error ? "page-size-error" : undefined}
            title="Enter 1–5,000 rows, then press Enter or leave this field"
            value={draft}
            disabled={busy}
            onChange={(e) => {
              if (/^\d*$/.test(e.target.value)) {
                setDraft(e.target.value);
                setError("");
                submitted.current = undefined;
              }
            }}
            onBlur={applySize}
            onKeyDown={(e) => {
              if (e.key === "Enter") {
                e.preventDefault();
                applySize();
              }
              if (e.key === "Escape") {
                e.preventDefault();
                setDraft(String(pageSize));
                setError("");
                submitted.current = undefined;
              }
            }}
          />
        </label>
        <span className="page-position">
          Page {page.toLocaleString()} of {pages.toLocaleString()}
        </span>
        <div className="page-buttons">
          <button
            className="icon-button"
            aria-label="First page"
            title="First page"
            disabled={busy || page <= 1}
            onClick={() => onChange(1, pageSize)}
          >
            <ChevronsLeft size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="Previous page"
            title="Previous page"
            disabled={busy || page <= 1}
            onClick={() => onChange(page - 1, pageSize)}
          >
            <ChevronLeft size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="Next page"
            title="Next page"
            disabled={busy || page >= pages}
            onClick={() => onChange(page + 1, pageSize)}
          >
            <ChevronRight size={15} />
          </button>
          <button
            className="icon-button"
            aria-label="Last page"
            title="Last page"
            disabled={busy || page >= pages}
            onClick={() => onChange(pages, pageSize)}
          >
            <ChevronsRight size={15} />
          </button>
        </div>
      </div>
      {error && (
        <span id="page-size-error" className="page-size-error" role="alert">
          {error}
        </span>
      )}
    </nav>
  );
}
