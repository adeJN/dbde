import { useEffect, useRef } from "react";
import { Save, X } from "lucide-react";

export type UnsavedChoice = "save" | "discard" | "cancel";

/** Asks whether to save a saved query's edits before its tab closes. */
export default function UnsavedQueryDialog({
  name,
  action,
  onResolve,
}: {
  name: string;
  /** What is about to happen, e.g. "Closing the tab". */
  action: string;
  onResolve: (choice: UnsavedChoice) => void;
}) {
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop confirmation-backdrop"
      onClick={(event) =>
        event.target === event.currentTarget && onResolve("cancel")
      }
    >
      <section
        ref={root}
        className="modal delete-dialog"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="unsaved-query-title"
        aria-describedby="unsaved-query-body"
        onKeyDown={(event) => {
          event.stopPropagation();
          if (event.key === "Escape") {
            event.preventDefault();
            onResolve("cancel");
          }
          if (event.key === "Tab") {
            const nodes = root.current?.querySelectorAll<HTMLElement>("button");
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
            <Save size={22} />
          </div>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={() => onResolve("cancel")}
          >
            <X size={18} />
          </button>
        </header>
        <h2 id="unsaved-query-title">Save changes to “{name}”?</h2>
        <p id="unsaved-query-body">
          This saved query has edits that are not saved. {action} loses them
          unless you save first.
        </p>
        <footer>
          <button
            className="button secondary"
            onClick={() => onResolve("cancel")}
          >
            Cancel
          </button>
          <button
            className="button destructive"
            onClick={() => onResolve("discard")}
          >
            Don’t save
          </button>
          <button
            className="button primary"
            autoFocus
            onClick={() => onResolve("save")}
          >
            Save
          </button>
        </footer>
      </section>
    </div>
  );
}
