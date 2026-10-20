import { useEffect, useMemo, useRef, useState } from "react";
import {
  Copy,
  FileCode2,
  FolderOpen,
  PencilLine,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { filterSavedQueries, type SavedQuery } from "../lib/saved-queries";

/** Every saved query, grouped by connection and database. */
export default function SavedQueriesPanel({
  queries,
  connectionName,
  initialSearch = "",
  onOpen,
  onRename,
  onDuplicate,
  onDelete,
  onClose,
}: {
  queries: SavedQuery[];
  connectionName: (profileId: string) => string;
  initialSearch?: string;
  onOpen: (query: SavedQuery) => void;
  onRename: (query: SavedQuery) => void;
  onDuplicate: (query: SavedQuery) => void;
  onDelete: (query: SavedQuery) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [text, setText] = useState(initialSearch);
  const groups = useMemo(() => {
    const map = new Map<string, { label: string; items: SavedQuery[] }>();
    for (const query of filterSavedQueries(queries, text)) {
      const key = JSON.stringify([query.profile_id, query.database]);
      const group = map.get(key) ?? {
        label: `${connectionName(query.profile_id)}${query.database ? ` / ${query.database}` : ""}`,
        items: [],
      };
      group.items.push(query);
      map.set(key, group);
    }
    return [...map.values()].sort((a, b) => a.label.localeCompare(b.label));
  }, [queries, text, connectionName]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    search.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={root}
        className="modal library-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="saved-queries-title"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onClose();
          }
          if (event.key === "Tab") {
            const nodes = root.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled)",
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
            <FileCode2 size={20} />
          </div>
          <div className="library-heading">
            <h2 id="saved-queries-title">Saved queries</h2>
            <small>
              {queries.length} saved quer{queries.length === 1 ? "y" : "ies"}
            </small>
          </div>
          <button
            className="icon-button"
            aria-label="Close saved queries"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <div className="library-toolbar">
          <label className="library-search">
            <Search size={14} />
            <input
              ref={search}
              value={text}
              placeholder="Search name, description or SQL…"
              aria-label="Search saved queries"
              onChange={(event) => setText(event.target.value)}
            />
          </label>
        </div>
        <div className="library-list">
          {groups.map((group) => (
            <section key={group.label} aria-label={group.label}>
              <h3 className="library-group">{group.label}</h3>
              <ul>
                {group.items.map((query) => (
                  <li key={query.id} className="saved-query-entry">
                    <button
                      className="saved-query-open"
                      title={query.query}
                      onClick={() => onOpen(query)}
                    >
                      <FileCode2 size={14} />
                      <span>
                        <strong>{query.name}</strong>
                        {query.description && (
                          <small>{query.description}</small>
                        )}
                      </span>
                    </button>
                    <time
                      dateTime={new Date(query.updated_at).toISOString()}
                      title="Last saved"
                    >
                      {new Date(query.updated_at).toLocaleDateString()}
                    </time>
                    <div className="library-actions">
                      <button
                        className="icon-button"
                        aria-label={`Open ${query.name}`}
                        title="Open"
                        onClick={() => onOpen(query)}
                      >
                        <FolderOpen size={13} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Rename ${query.name}`}
                        title="Rename"
                        onClick={() => onRename(query)}
                      >
                        <PencilLine size={13} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Duplicate ${query.name}`}
                        title="Duplicate"
                        onClick={() => onDuplicate(query)}
                      >
                        <Copy size={13} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Delete ${query.name}`}
                        title="Delete"
                        onClick={() => onDelete(query)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  </li>
                ))}
              </ul>
            </section>
          ))}
          {!groups.length && (
            <p className="empty-inline" role="status">
              {queries.length
                ? "No saved queries match."
                : "No saved queries yet. Press Save in a query tab to keep its SQL here."}
            </p>
          )}
        </div>
      </section>
    </div>
  );
}
