import { useCallback, useEffect, useRef, useState } from "react";
import {
  ArrowDownToLine,
  CircleArrowUp,
  CheckCircle2,
  Loader2,
  RefreshCw,
  X,
} from "lucide-react";
import { useWorkspace } from "../store";
import {
  checkUpdate,
  desktopUpdates,
  installUpdate,
  updateBlocker,
  updateStatus,
  type AvailableUpdate,
  type UpdateProgress,
  type UpdateStatus,
} from "../lib/updater";
import "./AppUpdater.css";

export default function AppUpdater() {
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<UpdateStatus>();
  const [available, setAvailable] = useState<AvailableUpdate | null>(null);
  const [checked, setChecked] = useState(false);
  const [checking, setChecking] = useState(false);
  const [installing, setInstalling] = useState(false);
  const [progress, setProgress] = useState<UpdateProgress>();
  const [error, setError] = useState("");
  const busy = useRef(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const dialog = useRef<HTMLElement>(null);
  const tabs = useWorkspace((state) => state.tabs);
  const connections = useWorkspace((state) => state.sessions.length);
  const blocker = updateBlocker(tabs, connections);

  const check = useCallback(async () => {
    if (busy.current) return;
    busy.current = true;
    setChecking(true);
    setError("");
    try {
      const configuration = await updateStatus();
      setStatus(configuration);
      if (configuration.configured) {
        setAvailable(await checkUpdate());
        setChecked(true);
      }
    } catch (cause) {
      setError(String(cause));
      setAvailable(null);
      setChecked(false);
    } finally {
      busy.current = false;
      setChecking(false);
    }
  }, []);

  useEffect(() => {
    // Delay launch checks slightly so opening the workspace takes priority.
    const startup = window.setTimeout(() => {
      void check();
    }, 5000);
    const interval = window.setInterval(
      () => {
        void check();
      },
      6 * 60 * 60 * 1000,
    );
    return () => {
      window.clearTimeout(startup);
      window.clearInterval(interval);
    };
  }, [check]);

  const close = useCallback(() => {
    if (installing) return;
    setOpen(false);
    trigger.current?.focus();
  }, [installing]);

  useEffect(() => {
    if (!open) return;
    dialog.current?.focus();
    const keyboard = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        close();
      }
      if (event.key === "Tab") {
        const elements = dialog.current?.querySelectorAll<HTMLElement>(
          "button:not(:disabled), [href], [tabindex='0']",
        );
        const first = elements?.[0],
          last = elements?.[elements.length - 1];
        if (!first || !last) {
          event.preventDefault();
          return;
        }
        if (
          event.shiftKey &&
          (document.activeElement === first ||
            document.activeElement === dialog.current)
        ) {
          event.preventDefault();
          last.focus();
        } else if (
          !event.shiftKey &&
          (document.activeElement === last ||
            document.activeElement === dialog.current)
        ) {
          event.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener("keydown", keyboard, true);
    return () => window.removeEventListener("keydown", keyboard, true);
  }, [open, close]);

  async function install() {
    const workspace = useWorkspace.getState();
    const reason = updateBlocker(workspace.tabs, workspace.sessions.length);
    if (reason || busy.current) {
      if (reason) setError(reason);
      return;
    }
    busy.current = true;
    setInstalling(true);
    setError("");
    setProgress({ event: "download", downloaded: 0, total: null });
    try {
      await installUpdate(setProgress);
      // Successful native installation restarts DBde.
    } catch (cause) {
      setError(String(cause));
      setInstalling(false);
      setProgress(undefined);
      busy.current = false;
    }
  }

  const percent =
    progress?.event === "download" && progress.total
      ? Math.min(100, Math.round((progress.downloaded / progress.total) * 100))
      : undefined;
  return (
    <>
      <button
        ref={trigger}
        className={`app-update-trigger${available ? " has-update" : ""}`}
        aria-label={
          available
            ? `App updates: version ${available.version} available`
            : "App updates"
        }
        title={
          available
            ? `DBde ${available.version} is available`
            : "Check for app updates"
        }
        aria-haspopup="dialog"
        aria-expanded={open}
        onClick={() => {
          setOpen(true);
          if (!status && !checking) void check();
        }}
      >
        <CircleArrowUp size={18} aria-hidden="true" />
        {available && <span className="app-update-label">Update</span>}
      </button>
      {open && (
        <div
          className="modal-backdrop app-update-backdrop"
          onMouseDown={(event) => {
            if (event.target === event.currentTarget) close();
          }}
        >
          <section
            ref={dialog}
            className="app-update-dialog"
            role="dialog"
            aria-modal="true"
            aria-labelledby="app-update-heading"
            aria-busy={checking || installing}
            tabIndex={-1}
          >
            <header>
              <span className="app-update-icon">
                <CircleArrowUp size={22} aria-hidden="true" />
              </span>
              <div>
                <h2 id="app-update-heading">App updates</h2>
                <p>DBde{status ? ` · Version ${status.currentVersion}` : ""}</p>
              </div>
              <button
                className="app-update-close"
                aria-label="Close app updates"
                onClick={close}
                disabled={installing}
              >
                <X size={20} />
              </button>
            </header>
            <div className="app-update-body">
              <div aria-live="polite">
                {checking ? (
                  <p className="app-update-state">
                    <Loader2 size={18} className="app-update-spin" />
                    Checking GitHub Releases…
                  </p>
                ) : available ? (
                  <h3>DBde {available.version} is available</h3>
                ) : checked ? (
                  <p className="app-update-state app-update-success">
                    <CheckCircle2 size={18} />
                    You’re up to date.
                  </p>
                ) : !desktopUpdates() ? (
                  <p>Install the desktop app to receive updates.</p>
                ) : status && !status.configured ? (
                  <p>Updates are not configured for this build.</p>
                ) : !error ? (
                  <p>Check for the latest version of DBde.</p>
                ) : null}
              </div>
              {available && (
                <>
                  {available.notes && (
                    <div className="app-update-notes">
                      <h4>What’s new</h4>
                      <p>{available.notes}</p>
                    </div>
                  )}
                  <p className="app-update-hint">
                    DBde verifies the update signature and restarts after
                    installation.
                  </p>
                  {!installing && blocker && (
                    <p className="app-update-hint">{blocker}</p>
                  )}
                </>
              )}
              {installing && (
                <div className="app-update-progress" role="status">
                  <p>
                    {progress?.event === "installing"
                      ? "Installing update… DBde will restart."
                      : `Downloading update${percent !== undefined ? `… ${percent}%` : "…"}`}
                  </p>
                  <progress
                    max={100}
                    value={
                      progress?.event === "installing" ? undefined : percent
                    }
                    aria-label="Update download progress"
                  />
                  {progress?.event === "download" && (
                    <small>
                      {(progress.downloaded / 1048576).toFixed(1)} MB downloaded
                    </small>
                  )}
                </div>
              )}
              {error && (
                <p className="app-update-error" role="alert">
                  {error}
                </p>
              )}
            </div>
            <footer>
              <button
                className="button secondary"
                onClick={close}
                disabled={installing}
              >
                {available ? "Later" : "Close"}
              </button>
              {available && !error ? (
                <button
                  className="button primary"
                  onClick={() => void install()}
                  disabled={checking || installing || !!blocker}
                >
                  {installing ? (
                    <Loader2 size={15} className="app-update-spin" />
                  ) : (
                    <ArrowDownToLine size={15} />
                  )}{" "}
                  Download &amp; install
                </button>
              ) : (
                <button
                  className="button primary"
                  onClick={() => void check()}
                  disabled={checking || installing || !desktopUpdates()}
                >
                  <RefreshCw size={15} />{" "}
                  {error ? "Retry" : "Check for updates"}
                </button>
              )}
            </footer>
          </section>
        </div>
      )}
    </>
  );
}
