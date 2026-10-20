import { useEffect, useMemo, useRef, useState } from "react";
import { Braces, PencilLine, Plus, Search, Trash2, X } from "lucide-react";
import type { Driver } from "../types";
import {
  expandSnippet,
  filterSnippets,
  snippetError,
  snippetsFor,
  type Snippet,
} from "../lib/snippets";

const DRIVER_NAMES: Record<Driver, string> = {
  postgres: "PostgreSQL",
  mysql: "MySQL/MariaDB",
  sqlite: "SQLite",
};

/** Snippet library: click a snippet to insert it at the editor cursor. */
export default function SnippetsPanel({
  driver,
  snippets,
  canInsert,
  onInsert,
  onSave,
  onDelete,
  onClose,
}: {
  driver: Driver;
  /** User snippets (built-ins are added here). */
  snippets: Snippet[];
  canInsert: boolean;
  onInsert: (snippet: Snippet) => void;
  onSave: (snippet: Snippet) => Promise<void>;
  onDelete: (snippet: Snippet) => void;
  onClose: () => void;
}) {
  const root = useRef<HTMLElement>(null);
  const search = useRef<HTMLInputElement>(null);
  const [text, setText] = useState("");
  const [draft, setDraft] = useState<Snippet | null>(null);
  const [failure, setFailure] = useState("");
  const [busy, setBusy] = useState(false);
  const visible = useMemo(
    () => filterSnippets(snippetsFor(driver, snippets), text),
    [driver, snippets, text],
  );
  const problem = draft ? snippetError(draft) : "";
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    search.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  async function save() {
    if (!draft || problem || busy) return;
    setBusy(true);
    setFailure("");
    try {
      await onSave({
        ...draft,
        id: draft.id || crypto.randomUUID(),
        name: draft.name.trim(),
        description: draft.description?.trim() || undefined,
      });
      setDraft(null);
    } catch (cause) {
      setFailure(String(cause));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        ref={root}
        className="modal library-dialog snippets-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="snippets-title"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            if (draft) setDraft(null);
            else onClose();
          }
          if (event.key === "Tab") {
            const nodes = root.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), textarea:not(:disabled)",
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
            <Braces size={20} />
          </div>
          <div className="library-heading">
            <h2 id="snippets-title">Code snippets</h2>
            <small>
              {DRIVER_NAMES[driver]} · type a prefix in the SQL editor, or click
              to insert
            </small>
          </div>
          <button
            className="icon-button"
            aria-label="Close snippets"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        {draft ? (
          <form
            className="snippet-form"
            aria-label={draft.id ? "Edit snippet" : "New snippet"}
            onSubmit={(event) => {
              event.preventDefault();
              void save();
            }}
          >
            <div className="snippet-form-row">
              <label>
                Name
                <input
                  autoFocus
                  value={draft.name}
                  maxLength={120}
                  onChange={(event) =>
                    setDraft({ ...draft, name: event.target.value })
                  }
                />
              </label>
              <label>
                Prefix
                <input
                  value={draft.prefix}
                  maxLength={40}
                  spellCheck={false}
                  onChange={(event) =>
                    setDraft({ ...draft, prefix: event.target.value })
                  }
                />
              </label>
            </div>
            <label>
              Description (optional)
              <input
                value={draft.description ?? ""}
                maxLength={300}
                onChange={(event) =>
                  setDraft({ ...draft, description: event.target.value })
                }
              />
            </label>
            <label>
              Body — use ${"{1:name}"} for placeholders and $0 for the final
              cursor
              <textarea
                value={draft.body}
                rows={8}
                spellCheck={false}
                onChange={(event) =>
                  setDraft({ ...draft, body: event.target.value })
                }
              />
            </label>
            <label className="snippet-driver">
              <input
                type="checkbox"
                checked={!!draft.drivers?.length}
                onChange={(event) =>
                  setDraft({
                    ...draft,
                    drivers: event.target.checked ? [driver] : undefined,
                  })
                }
              />
              Only for {DRIVER_NAMES[draft.drivers?.[0] ?? driver]}
            </label>
            <small className="rename-problem" role="status">
              {problem}
            </small>
            {failure && (
              <div className="form-message error" role="alert">
                {failure}
              </div>
            )}
            <footer>
              <button
                type="button"
                className="button secondary"
                onClick={() => setDraft(null)}
              >
                Cancel
              </button>
              <button className="button primary" disabled={!!problem || busy}>
                Save snippet
              </button>
            </footer>
          </form>
        ) : (
          <>
            <div className="library-toolbar">
              <label className="library-search">
                <Search size={14} />
                <input
                  ref={search}
                  value={text}
                  placeholder="Search snippets…"
                  aria-label="Search snippets"
                  onChange={(event) => setText(event.target.value)}
                />
              </label>
              <button
                className="button secondary"
                onClick={() => {
                  setFailure("");
                  setDraft({
                    id: "",
                    name: "",
                    prefix: "",
                    body: "",
                  });
                }}
              >
                <Plus size={14} /> New snippet
              </button>
            </div>
            {!canInsert && (
              <p className="library-note" role="note">
                Open a query tab to insert snippets.
              </p>
            )}
            <ul className="library-list snippet-list" aria-label="Snippets">
              {visible.map((snippet) => (
                <li key={snippet.id} className="snippet-entry">
                  <button
                    className="snippet-insert"
                    disabled={!canInsert}
                    aria-label={`Insert snippet ${snippet.name} (${snippet.prefix})`}
                    onClick={() => onInsert(snippet)}
                  >
                    <span className="snippet-title">
                      <strong>{snippet.name}</strong>
                      <kbd>{snippet.prefix}</kbd>
                      {!snippet.builtin && (
                        <span className="snippet-badge">Mine</span>
                      )}
                    </span>
                    <pre>{expandSnippet(snippet.body)}</pre>
                  </button>
                  {!snippet.builtin && (
                    <div className="library-actions">
                      <button
                        className="icon-button"
                        aria-label={`Edit snippet ${snippet.name}`}
                        onClick={() => {
                          setFailure("");
                          setDraft(snippet);
                        }}
                      >
                        <PencilLine size={13} />
                      </button>
                      <button
                        className="icon-button"
                        aria-label={`Delete snippet ${snippet.name}`}
                        onClick={() => onDelete(snippet)}
                      >
                        <Trash2 size={13} />
                      </button>
                    </div>
                  )}
                </li>
              ))}
            </ul>
            {!visible.length && (
              <p className="empty-inline" role="status">
                No snippets match.
              </p>
            )}
          </>
        )}
      </section>
    </div>
  );
}
