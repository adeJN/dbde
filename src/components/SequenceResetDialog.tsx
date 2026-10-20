import { useEffect, useRef, useState } from "react";
import { RotateCcw, X } from "lucide-react";
import type { DbObject } from "../types";

/** Asks for the value a sequence restarts with; the exact SQL is confirmed afterwards. */
export default function SequenceResetDialog({
  sequence,
  onSubmit,
  onClose,
}: {
  sequence: DbObject;
  onSubmit: (value: string) => void;
  onClose: () => void;
}) {
  const input = useRef<HTMLInputElement>(null);
  const [value, setValue] = useState(sequence.start ?? "1");
  const valid = /^-?\d{1,19}$/.test(value.trim());
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    input.current?.focus();
    input.current?.select();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  const name = `${sequence.schema ? sequence.schema + "." : ""}${sequence.name}`;
  return (
    <div
      className="modal-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="modal rename-dialog sequence-reset-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="sequence-reset-title"
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
            <RotateCcw size={20} />
          </div>
          <button
            className="icon-button"
            aria-label="Close reset sequence"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <h2 id="sequence-reset-title">Reset sequence {name}</h2>
        <dl className="sequence-facts">
          <dt>Current value</dt>
          <dd>{sequence.last_value ?? "not used yet"}</dd>
          <dt>Increment</dt>
          <dd>{sequence.increment ?? "—"}</dd>
          <dt>Start</dt>
          <dd>{sequence.start ?? "—"}</dd>
        </dl>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) onSubmit(value.trim());
          }}
        >
          <label>
            Restart with
            <input
              ref={input}
              value={value}
              inputMode="numeric"
              spellCheck={false}
              autoComplete="off"
              aria-invalid={!valid}
              aria-describedby="sequence-reset-help"
              onChange={(event) => setValue(event.target.value)}
            />
          </label>
          <small
            id="sequence-reset-help"
            className="rename-problem"
            role="status"
          >
            {valid
              ? "The next nextval() returns this value. Existing rows are not changed."
              : "Enter a whole number."}
          </small>
          <footer>
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button className="button primary" disabled={!valid}>
              Continue…
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
