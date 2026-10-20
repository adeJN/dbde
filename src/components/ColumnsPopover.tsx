import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { Search, Snowflake } from "lucide-react";

/** Navicat-style Columns popover: tick the columns the grid shows. */
export default function ColumnsPopover({
  columns,
  hidden,
  frozen,
  types,
  trigger,
  onChange,
  onClose,
}: {
  columns: string[];
  hidden: string[];
  frozen: string[];
  /** Column data types by name, when metadata is known. */
  types?: Record<string, string | undefined>;
  /** Receives focus back when the popover is dismissed from the keyboard. */
  trigger: RefObject<HTMLElement | null>;
  onChange: (hidden: string[]) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState("");
  const id = useId();
  const term = query.trim().toLowerCase();
  const listed = columns.filter((name) => name.toLowerCase().includes(term));
  const close = useRef(onClose);
  close.current = onClose;
  useEffect(() => {
    search.current?.focus();
    const outside = (event: Event) => {
      const target = event.target as Node;
      if (!root.current?.contains(target) && !trigger.current?.contains(target))
        close.current();
    };
    document.addEventListener("mousedown", outside);
    return () => document.removeEventListener("mousedown", outside);
  }, []);
  function dismiss() {
    onClose();
    trigger.current?.focus();
  }
  const set = (names: string[], hide: boolean) =>
    onChange(
      hide
        ? [...hidden, ...names.filter((name) => !hidden.includes(name))]
        : hidden.filter((name) => !names.includes(name)),
    );
  return (
    <div
      ref={root}
      className="columns-popover"
      role="dialog"
      aria-label="Show or hide columns"
      aria-describedby={`${id}-count`}
      onKeyDown={(event) => {
        if (event.key === "Escape") {
          event.preventDefault();
          event.stopPropagation();
          dismiss();
        }
      }}
    >
      <label className="search small columns-popover-search">
        <Search size={13} />
        <input
          ref={search}
          aria-label="Search columns"
          placeholder="Search columns…"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
        />
      </label>
      <div className="columns-popover-actions">
        <button
          className="button subtle"
          disabled={!listed.some((name) => hidden.includes(name))}
          onClick={() => set(listed, false)}
        >
          Show all
        </button>
        <button
          className="button subtle"
          disabled={listed.every((name) => hidden.includes(name))}
          onClick={() => set(listed, true)}
        >
          Hide all
        </button>
        <span id={`${id}-count`} className="columns-popover-count">
          {hidden.length
            ? `${hidden.length} of ${columns.length} hidden`
            : "All columns shown"}
        </span>
      </div>
      <ul className="columns-popover-list" aria-label="Columns">
        {listed.map((name) => (
          <li key={name}>
            <label>
              <input
                type="checkbox"
                checked={!hidden.includes(name)}
                onChange={(event) => set([name], !event.target.checked)}
              />
              <span className="columns-popover-name">{name}</span>
              {frozen.includes(name) && (
                <Snowflake size={11} aria-label="frozen" />
              )}
              {types?.[name] && (
                <span className="columns-popover-type">{types[name]}</span>
              )}
            </label>
          </li>
        ))}
        {!listed.length && (
          <li className="columns-popover-empty">No columns match.</li>
        )}
      </ul>
    </div>
  );
}
