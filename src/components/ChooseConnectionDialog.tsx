import { useEffect, useRef, useState } from "react";
import { Database, X } from "lucide-react";

/** Picks an open connection (and database) for SQL whose own connection is gone. */
export default function ChooseConnectionDialog({
  reason,
  sessions,
  onChoose,
  onClose,
}: {
  reason: string;
  sessions: { id: string; name: string; databases: string[] }[];
  onChoose: (sessionId: string, database?: string) => void;
  onClose: () => void;
}) {
  const select = useRef<HTMLSelectElement>(null);
  const [sessionId, setSessionId] = useState(sessions[0]?.id ?? "");
  const current = sessions.find((session) => session.id === sessionId);
  const [database, setDatabase] = useState(current?.databases[0] ?? "");
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    select.current?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop confirmation-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <section
        className="modal rename-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby="choose-connection-title"
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
            <Database size={20} />
          </div>
          <button
            className="icon-button"
            aria-label="Close connection chooser"
            onClick={onClose}
          >
            <X size={18} />
          </button>
        </header>
        <h2 id="choose-connection-title">Choose a connection</h2>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            if (sessionId) onChoose(sessionId, database || undefined);
          }}
        >
          <p className="rename-impact">{reason}</p>
          <label>
            Connection
            <select
              ref={select}
              value={sessionId}
              onChange={(event) => {
                setSessionId(event.target.value);
                setDatabase(
                  sessions.find((s) => s.id === event.target.value)
                    ?.databases[0] ?? "",
                );
              }}
            >
              {sessions.map((session) => (
                <option key={session.id} value={session.id}>
                  {session.name}
                </option>
              ))}
            </select>
          </label>
          {!!current?.databases.length && (
            <label>
              Database
              <select
                value={database}
                onChange={(event) => setDatabase(event.target.value)}
              >
                {current.databases.map((name) => (
                  <option key={name} value={name}>
                    {name}
                  </option>
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
            <button className="button primary" disabled={!sessionId}>
              Open query tab
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
