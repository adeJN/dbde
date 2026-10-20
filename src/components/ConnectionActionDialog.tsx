import { useEffect, useRef, useState } from "react";
import { FolderPlus, FileCode2, X } from "lucide-react";
import type { Session } from "../types";
export default function ConnectionActionDialog({
  mode,
  session,
  initialGroup,
  onClose,
  onSubmit,
}: {
  mode: "group" | "execute-file";
  session: Session;
  initialGroup?: string;
  onClose: () => void;
  onSubmit: (value: string) => void;
}) {
  const [value, setValue] = useState(
    mode === "group"
      ? (initialGroup ?? "")
      : session.config.database || session.databases?.[0] || "",
  );
  const root = useRef<HTMLElement>(null);
  const databases = [
    ...new Set(
      [...(session.databases ?? []), session.config.database].filter(Boolean),
    ),
  ];
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    root.current?.querySelector<HTMLElement>("input,select")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div className="modal-backdrop">
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-action-title"
        ref={root}
        onKeyDown={(event) => {
          if (event.key === "Escape") onClose();
          if (event.key === "Tab") {
            const items = Array.from(
              root.current?.querySelectorAll<HTMLElement>(
                "button:not(:disabled), input, select",
              ) ?? [],
            );
            if (event.shiftKey && document.activeElement === items[0]) {
              event.preventDefault();
              items.at(-1)?.focus();
            } else if (
              !event.shiftKey &&
              document.activeElement === items.at(-1)
            ) {
              event.preventDefault();
              items[0]?.focus();
            }
          }
        }}
      >
        <header>
          <div className="modal-icon">
            {mode === "group" ? (
              <FolderPlus size={22} />
            ) : (
              <FileCode2 size={22} />
            )}
          </div>
          <button
            className="icon-button"
            aria-label="Close connection action"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <h2 id="connection-action-title">
          {mode === "group" ? "New Connection Group" : "Execute SQL File"}
        </h2>
        <p>{session.config.name}</p>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (value.trim()) onSubmit(value.trim());
          }}
        >
          {mode === "group" ? (
            <label>
              Group name
              <input
                aria-label="Group name"
                maxLength={60}
                value={value}
                onChange={(event) => setValue(event.target.value)}
                required
                placeholder="e.g. Local development"
              />
            </label>
          ) : (
            <label>
              Target database
              <select
                aria-label="Target database"
                value={value}
                onChange={(event) => setValue(event.target.value)}
                required
              >
                <option value="">Choose a database</option>
                {databases.map((database) => (
                  <option key={database}>{database}</option>
                ))}
              </select>
            </label>
          )}
          <footer>
            <button
              type="button"
              className="button secondary"
              onClick={onClose}
            >
              Cancel
            </button>
            <button className="button primary" disabled={!value.trim()}>
              {mode === "group" ? "Save group" : "Choose SQL file…"}
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
