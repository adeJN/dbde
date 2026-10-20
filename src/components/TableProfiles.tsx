import { useState } from "react";
import { BookMarked, X } from "lucide-react";
import type { TableFilter, TableSort } from "../types";
import type { GridLayout } from "../lib/grid-layout";
import {
  checkedProfile,
  readTableProfiles,
  saveTableProfiles,
  type TableProfile,
} from "../lib/table-profiles";
export default function TableProfiles({
  storageKey,
  columns,
  filters,
  sort,
  layout,
  disabled,
  onApply,
}: {
  storageKey: string;
  columns: string[];
  filters: TableFilter[];
  sort?: TableSort;
  layout: GridLayout;
  disabled: boolean;
  onApply: (profile: TableProfile) => void;
}) {
  const [open, setOpen] = useState(false),
    [list, setList] = useState(() => readTableProfiles(storageKey)),
    [name, setName] = useState(""),
    [error, setError] = useState("");
  function save() {
    if (!name.trim()) return;
    const next = {
      id: crypto.randomUUID(),
      name: name.trim().slice(0, 80),
      filters,
      sort,
      layout,
    };
    const values = [
      ...list.filter((p) => p.name.toLowerCase() !== next.name.toLowerCase()),
      next,
    ];
    try {
      saveTableProfiles(storageKey, values);
      setList(values);
      setName("");
      setError("");
    } catch (e) {
      setError(String(e));
    }
  }
  return (
    <>
      <button
        className="button row-action icon-only"
        aria-label="Table profiles"
        title="Save or apply table profiles"
        disabled={disabled}
        onClick={() => {
          setList(readTableProfiles(storageKey));
          setOpen(true);
        }}
      >
        <BookMarked size={14} />
      </button>
      {open && (
        <div
          className="modal-backdrop"
          onMouseDown={(e) => {
            if (e.target === e.currentTarget) setOpen(false);
          }}
        >
          <section
            role="dialog"
            aria-modal="true"
            aria-label="Table profiles"
            className="modal table-profiles-dialog"
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === "Escape") setOpen(false);
              if (e.key === "Tab") {
                const nodes = Array.from(
                  e.currentTarget.querySelectorAll<HTMLElement>(
                    "button:not(:disabled),input:not(:disabled)",
                  ),
                );
                if (e.shiftKey && document.activeElement === nodes[0]) {
                  e.preventDefault();
                  nodes.at(-1)?.focus();
                } else if (
                  !e.shiftKey &&
                  document.activeElement === nodes.at(-1)
                ) {
                  e.preventDefault();
                  nodes[0]?.focus();
                }
              }
            }}
          >
            <header>
              <h2>Table profiles</h2>
              <button
                className="icon-button"
                aria-label="Close table profiles"
                onClick={() => setOpen(false)}
              >
                <X size={16} />
              </button>
            </header>
            <p>
              Remember a named combination of filters, sort, hidden columns and
              frozen columns for this table.
            </p>
            <div className="admin-row">
              <input
                autoFocus
                aria-label="Profile name"
                placeholder="Profile name"
                maxLength={80}
                value={name}
                onChange={(e) => setName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") save();
                }}
              />
              <button
                className="button primary"
                disabled={!name.trim()}
                onClick={save}
              >
                Save current view
              </button>
            </div>
            {list.map((profile) => (
              <div className="admin-row" key={profile.id}>
                <strong>{profile.name}</strong>
                <span className="admin-muted">
                  {profile.filters.length} filters ·{" "}
                  {profile.sort
                    ? `${profile.sort.column} ${profile.sort.direction}`
                    : "No sort"}{" "}
                  · {profile.layout.hidden.length} hidden
                </span>
                <button
                  className="button"
                  onClick={() => {
                    try {
                      onApply(checkedProfile(profile, columns));
                      setOpen(false);
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  Apply
                </button>
                <button
                  className="button subtle danger"
                  onClick={() => {
                    const next = list.filter((p) => p.id !== profile.id);
                    try {
                      saveTableProfiles(storageKey, next);
                      setList(next);
                    } catch (e) {
                      setError(String(e));
                    }
                  }}
                >
                  Delete
                </button>
              </div>
            ))}
            {!list.length && <p>No saved profiles for this table.</p>}
            {error && (
              <p className="error-banner" role="alert">
                {error}
              </p>
            )}
          </section>
        </div>
      )}
    </>
  );
}
