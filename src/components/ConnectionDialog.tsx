import { useState } from "react";
import { Database, X, ShieldCheck, Loader2, CheckCircle2 } from "lucide-react";
import type { ConnectionConfig, Driver } from "../types";
import * as api from "../lib/api";
export default function ConnectionDialog({
  onClose,
  onConnected,
}: {
  onClose: () => void;
  onConnected: (id: string, config: ConnectionConfig) => void;
}) {
  const [config, setConfig] = useState<ConnectionConfig>({
    id: crypto.randomUUID(),
    name: "",
    driver: "postgres",
    host: "localhost",
    port: 5432,
    username: "postgres",
    password: "",
    database: "",
    ssl_mode: "require",
    file_path: "",
  });
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const [save, setSave] = useState(true);
  function change(patch: Partial<ConnectionConfig>) {
    setConfig((c) => ({ ...c, ...patch }));
    setMessage("");
  }
  function driver(driver: Driver) {
    change({
      driver,
      port: driver === "mysql" ? 3306 : 5432,
      username: driver === "mysql" ? "root" : "postgres",
      ssl_mode: driver === "sqlite" ? "disable" : "require",
    });
  }
  async function action(test: boolean) {
    setBusy(test ? "test" : "connect");
    setMessage("");
    setSuccess(false);
    let id: string | undefined;
    try {
      if (
        !config.name.trim() ||
        (config.driver === "sqlite"
          ? !config.file_path.trim()
          : !config.host.trim() ||
            !config.username.trim() ||
            config.port < 1 ||
            config.port > 65535)
      )
        throw new Error("Complete the connection name and database details.");
      if (test) {
        await api.testConnection(config);
        setSuccess(true);
        setMessage("Connection verified. Ready to connect.");
      } else {
        id = await api.connect(config);
        if (save) await api.saveProfile(config);
        onConnected(id, { ...config, password: undefined });
        onClose();
      }
    } catch (error) {
      if (id) await api.disconnect(id).catch(() => {});
      setMessage(String(error));
    } finally {
      setBusy("");
    }
  }
  return (
    <div
      className="modal-backdrop"
      onMouseDown={(e) => e.target === e.currentTarget && !busy && onClose()}
    >
      <section
        className="modal"
        role="dialog"
        aria-modal="true"
        aria-labelledby="connection-title"
      >
        <header>
          <div className="modal-icon">
            <Database size={23} />
          </div>
          <button
            className="icon-button"
            aria-label="Close dialog"
            onClick={onClose}
            disabled={!!busy}
          >
            <X size={18} />
          </button>
        </header>
        <h2 id="connection-title">Connect your database</h2>
        <p>A new home for your data. All connections stay on your device.</p>
        <div className="driver-options">
          {(["postgres", "mysql", "sqlite"] as Driver[]).map((d) => (
            <button
              key={d}
              className={config.driver === d ? "selected" : ""}
              onClick={() => driver(d)}
            >
              {d === "postgres"
                ? "PostgreSQL"
                : d === "mysql"
                  ? "MySQL"
                  : "SQLite"}
            </button>
          ))}
        </div>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            void action(false);
          }}
        >
          <label>
            Connection name
            <input
              autoFocus
              value={config.name}
              onChange={(e) => change({ name: e.target.value })}
              placeholder="e.g. Production analytics"
              required
            />
          </label>
          {config.driver === "sqlite" ? (
            <label>
              Database file path
              <input
                value={config.file_path}
                onChange={(e) => change({ file_path: e.target.value })}
                placeholder="/absolute/path/database.sqlite"
                required
              />
              <small>
                A new file will be created if the path does not exist.
              </small>
            </label>
          ) : (
            <>
              <div className="form-row">
                <label>
                  Host
                  <input
                    value={config.host}
                    onChange={(e) => change({ host: e.target.value })}
                    required
                  />
                </label>
                <label className="port">
                  Port
                  <input
                    type="number"
                    min={1}
                    max={65535}
                    value={config.port}
                    onChange={(e) => change({ port: Number(e.target.value) })}
                    required
                  />
                </label>
              </div>
              <div className="form-row">
                <label>
                  Username
                  <input
                    value={config.username}
                    onChange={(e) => change({ username: e.target.value })}
                    autoComplete="off"
                    required
                  />
                </label>
                <label>
                  Password
                  <input
                    type="password"
                    value={config.password}
                    onChange={(e) => change({ password: e.target.value })}
                    autoComplete="new-password"
                  />
                </label>
              </div>
              <label>
                Initial database (optional)
                <input
                  value={config.database}
                  onChange={(e) => change({ database: e.target.value })}
                  placeholder="Leave blank to browse all databases"
                />
                <small>
                  All databases available to this account appear after
                  connecting. PostgreSQL uses postgres as the initial database
                  when blank.
                </small>
              </label>
              <label>
                SSL mode
                <select
                  value={config.ssl_mode}
                  onChange={(e) =>
                    change({
                      ssl_mode: e.target.value as ConnectionConfig["ssl_mode"],
                    })
                  }
                >
                  <option value="require">Require encryption</option>
                  <option value="verify-full">
                    Verify certificate & hostname
                  </option>
                  <option value="disable">Disable (local development)</option>
                </select>
              </label>
            </>
          )}
          <label className="checkbox">
            <input
              type="checkbox"
              checked={save}
              onChange={(e) => setSave(e.target.checked)}
            />{" "}
            Save connection to this device
          </label>
          <div className="security-note">
            <ShieldCheck size={16} /> Passwords are stored in your OS credential
            vault.
          </div>
          {message && (
            <div
              role="status"
              className={`form-message ${success ? "success" : "error"}`}
            >
              {success && <CheckCircle2 size={15} />} {message}
            </div>
          )}
          <footer>
            <button
              type="button"
              className="button secondary"
              onClick={() => void action(true)}
              disabled={!!busy}
            >
              {busy === "test" && <Loader2 size={14} className="spin" />} Test
              connection
            </button>
            <button className="button primary" disabled={!!busy}>
              {busy === "connect" && <Loader2 size={14} className="spin" />}{" "}
              Connect database
            </button>
          </footer>
        </form>
      </section>
    </div>
  );
}
