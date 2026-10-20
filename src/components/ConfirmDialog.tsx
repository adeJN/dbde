import { useEffect, useRef, useState, type ReactNode } from "react";
import { AlertTriangle, ChevronsUpDown, X } from "lucide-react";
import appIcon from "../../app-icon.svg";
import type { ForeignKeyChecks } from "../types";
export interface ConfirmRequest {
  title: string;
  body: ReactNode;
  confirmLabel: string;
  /** Statements or names to show verbatim, such as the SQL about to run. */
  details?: string[];
  tableDeletion?: {
    allowForeignKeyChecks: boolean;
    onForeignKeyChecks: (mode: ForeignKeyChecks) => void;
  };
}
export default function ConfirmDialog({
  request,
  onResolve,
}: {
  request: ConfirmRequest;
  onResolve: (confirmed: boolean) => void;
}) {
  const root = useRef<HTMLElement>(null);
  const [acknowledged, setAcknowledged] = useState(false);
  const [foreignKeyChecks, setForeignKeyChecks] =
    useState<ForeignKeyChecks>("default");
  useEffect(() => {
    setAcknowledged(false);
    setForeignKeyChecks("default");
  }, [request]);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  return (
    <div
      className="modal-backdrop confirmation-backdrop"
      onClick={(e) => e.target === e.currentTarget && onResolve(false)}
    >
      <section
        ref={root}
        className={`modal delete-dialog${request.tableDeletion ? " table-delete-dialog" : ""}`}
        role="alertdialog"
        aria-modal="true"
        aria-labelledby="confirm-title"
        aria-describedby={
          request.tableDeletion ? "confirm-delete-help" : "confirm-body"
        }
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            onResolve(false);
          }
          if (e.key === "Tab") {
            const nodes = root.current?.querySelectorAll<HTMLElement>(
              "button:not(:disabled), input:not(:disabled), select:not(:disabled)",
            );
            if (!nodes?.length) return;
            const first = nodes[0],
              last = nodes[nodes.length - 1];
            if (e.shiftKey && document.activeElement === first) {
              e.preventDefault();
              last.focus();
            } else if (!e.shiftKey && document.activeElement === last) {
              e.preventDefault();
              first.focus();
            }
          }
        }}
      >
        {request.tableDeletion ? (
          <img
            className="delete-app-logo"
            src={appIcon}
            alt="DBde"
            width={72}
            height={72}
          />
        ) : (
          <header>
            <div className="modal-icon destructive">
              <AlertTriangle size={23} />
            </div>
            <button
              className="icon-button"
              aria-label="Close dialog"
              onClick={() => onResolve(false)}
            >
              <X size={18} />
            </button>
          </header>
        )}
        <h2 id="confirm-title">{request.title}</h2>
        {request.tableDeletion ? (
          <>
            <label className="delete-foreign-keys">
              <span>Foreign Key Checks</span>
              <span className="delete-select-wrap">
                <select
                  value={foreignKeyChecks}
                  disabled={!request.tableDeletion.allowForeignKeyChecks}
                  onChange={(event) =>
                    setForeignKeyChecks(event.target.value as ForeignKeyChecks)
                  }
                >
                  <option value="default">Default</option>
                  {request.tableDeletion.allowForeignKeyChecks && (
                    <>
                      <option value="enable">Enable</option>
                      <option value="disable">Disable</option>
                    </>
                  )}
                </select>
                <ChevronsUpDown size={14} aria-hidden="true" />
              </span>
            </label>
            <label className="delete-acknowledgement" id="confirm-delete-help">
              <input
                type="checkbox"
                checked={acknowledged}
                onChange={(event) => setAcknowledged(event.target.checked)}
              />
              <span>
                I understand that this action is permanent and cannot be undone
              </span>
            </label>
          </>
        ) : (
          <p id="confirm-body">{request.body}</p>
        )}
        {!request.tableDeletion && request.details?.length ? (
          <div className="delete-preview">
            {request.details.slice(0, 5).map((detail, i) => (
              <code key={i}>{detail}</code>
            ))}
            {request.details.length > 5 && (
              <small>and {request.details.length - 5} more</small>
            )}
          </div>
        ) : null}
        <footer>
          <button
            className={`button ${request.tableDeletion ? "primary" : "secondary"}`}
            autoFocus
            onClick={() => onResolve(false)}
          >
            Cancel
          </button>
          <button
            className="button destructive"
            disabled={!!request.tableDeletion && !acknowledged}
            onClick={() => {
              if (request.tableDeletion && !acknowledged) return;
              request.tableDeletion?.onForeignKeyChecks(foreignKeyChecks);
              onResolve(true);
            }}
          >
            {request.confirmLabel}
          </button>
        </footer>
      </section>
    </div>
  );
}
