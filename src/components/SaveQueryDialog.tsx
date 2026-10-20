import { useEffect, useRef, useState } from "react";
import { Loader2, Save, X } from "lucide-react";

/** Name (and optional description) for saving, saving as or renaming a query. */
export default function SaveQueryDialog({
  title,
  submitLabel,
  location,
  initialName,
  initialDescription = "",
  nameError,
  onSubmit,
  onClose,
}: {
  title: string;
  submitLabel: string;
  /** Where the query is saved, e.g. "Local / app". */
  location: string;
  initialName: string;
  initialDescription?: string;
  nameError: (name: string) => string;
  /** Resolves when saved; rejects with the reason shown in the dialog. */
  onSubmit: (value: { name: string; description: string }) => Promise<void>;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [name, setName] = useState(initialName);
  const [description, setDescription] = useState(initialDescription);
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState("");
  const problem = nameError(name);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    input.current?.select();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  async function submit() {
    if (problem || busy) return;
    setBusy(true);
    setFailure("");
    try {
      await onSubmit({ name: name.trim(), description: description.trim() });
    } catch (cause) {
      setFailure(String(cause));
      setBusy(false);
    }
  }
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget && !busy) onClose();
      }}
    >
      <section
        className="modal rename-dialog save-query-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="save-query-title"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape" && !busy) {
            event.preventDefault();
            onClose();
          }
        }}
      >
        <header>
          <div className="modal-icon">
            <Save size={20} />
          </div>
          <button
            className="icon-button"
            aria-label="Close save query"
            disabled={busy}
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <h2 id="save-query-title">{title}</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <label>
            Query name
            <input
              ref={input}
              value={name}
              disabled={busy}
              spellCheck={false}
              autoComplete="off"
              maxLength={200}
              aria-invalid={!!problem}
              aria-describedby="save-query-problem"
              onChange={(event) => {
                setName(event.target.value);
                setFailure("");
              }}
            />
          </label>
          <small
            id="save-query-problem"
            className="rename-problem"
            role="status"
          >
            {name === initialName && !name.trim() ? "" : problem}
          </small>
          <label>
            Description (optional)
            <textarea
              value={description}
              disabled={busy}
              rows={3}
              maxLength={2000}
              onChange={(event) => setDescription(event.target.value)}
            />
          </label>
          <p className="rename-impact">Saved in {location}</p>
          {failure && (
            <div className="form-message error" role="alert">
              {failure}
            </div>
          )}
          <footer>
            <button
              type="button"
              className="button secondary"
              disabled={busy}
              onClick={onClose}
            >
              Cancel
            </button>
            <button className="button primary" disabled={!!problem || busy}>
              {busy && <Loader2 size={14} className="spin" />} {submitLabel}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
