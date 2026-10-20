import ConnectionDatabases from "./ConnectionDatabases";
import type { ConnectionConfig, ConnectionOptions } from "../types";
export type ConnectionSection =
  "General" | "Advanced" | "Databases" | "SSL" | "SSH" | "Remarks";

export default function ConnectionSettings({
  config,
  section,
  onSection,
  onChange,
  onSsl,
  mode,
  initialConfig,
}: {
  config: ConnectionConfig;
  section: ConnectionSection;
  onSection: (section: ConnectionSection) => void;
  onChange: (patch: Partial<ConnectionConfig>) => void;
  onSsl: (mode: ConnectionConfig["ssl_mode"]) => void;
  mode: "create" | "edit" | "duplicate";
  initialConfig?: ConnectionConfig;
}) {
  const options = config.options ?? {};
  const option = (patch: Partial<ConnectionOptions>) =>
    onChange({ options: { ...options, ...patch } });
  const tabs: ConnectionSection[] =
    config.driver === "sqlite"
      ? ["General", "Advanced", "Remarks"]
      : ["General", "Advanced", "Databases", "SSL", "SSH", "Remarks"];
  const ssh = options.ssh ?? {};
  const changeSsh = (patch: Partial<NonNullable<ConnectionOptions["ssh"]>>) =>
    option({
      ssh: {
        ...ssh,
        password: ssh.password ?? (mode === "edit" ? undefined : ""),
        ...patch,
      },
    });
  const path = (
    label: string,
    key: "socket_path" | "ssl_ca" | "ssl_cert" | "ssl_key",
  ) => (
    <label>
      {label}
      <input
        aria-label={label}
        value={options[key] ?? ""}
        onChange={(event) => option({ [key]: event.target.value })}
        placeholder="/absolute/path/to/file"
        autoComplete="off"
        spellCheck={false}
      />
    </label>
  );
  return (
    <>
      <div
        className="connection-settings-tabs"
        role="tablist"
        aria-label="Connection settings"
      >
        {tabs.map((tab, index) => (
          <button
            type="button"
            role="tab"
            id={`connection-tab-${tab}`}
            aria-selected={section === tab}
            aria-controls="connection-settings-panel"
            tabIndex={section === tab ? 0 : -1}
            key={tab}
            onClick={() => onSection(tab)}
            onKeyDown={(event) => {
              if (
                !["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)
              )
                return;
              event.preventDefault();
              const next =
                event.key === "Home"
                  ? 0
                  : event.key === "End"
                    ? tabs.length - 1
                    : (index +
                        (event.key === "ArrowRight" ? 1 : -1) +
                        tabs.length) %
                      tabs.length;
              onSection(tabs[next]);
              event.currentTarget.parentElement
                ?.querySelectorAll<HTMLButtonElement>("button")
                [next]?.focus();
            }}
          >
            {tab}
          </button>
        ))}
      </div>
      <div
        className="connection-settings-panel"
        id="connection-settings-panel"
        role="tabpanel"
        aria-labelledby={`connection-tab-${section}`}
      >
        {section === "General" && (
          <>
            <label>
              Connection name
              <input
                autoFocus
                value={config.name}
                onChange={(event) => onChange({ name: event.target.value })}
                placeholder="e.g. Production analytics"
                required
              />
            </label>
            {config.driver === "sqlite" ? (
              <label>
                Database file path
                <input
                  value={config.file_path}
                  onChange={(event) =>
                    onChange({ file_path: event.target.value })
                  }
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
                      onChange={(event) =>
                        onChange({ host: event.target.value })
                      }
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
                      onChange={(event) =>
                        onChange({ port: Number(event.target.value) })
                      }
                      required
                    />
                  </label>
                </div>
                <div className="form-row">
                  <label>
                    Username
                    <input
                      value={config.username}
                      onChange={(event) =>
                        onChange({ username: event.target.value })
                      }
                      autoComplete="off"
                      required
                    />
                  </label>
                  <label>
                    Password
                    <input
                      type="password"
                      value={config.password ?? ""}
                      placeholder={
                        mode === "edit" && initialConfig?.password === undefined
                          ? "Leave unchanged to keep saved password"
                          : undefined
                      }
                      onChange={(event) =>
                        onChange({ password: event.target.value })
                      }
                      autoComplete="new-password"
                    />
                  </label>
                </div>
                <p className="connection-section-hint">
                  Use Databases to focus this connection, or SSL to configure
                  encrypted access.
                </p>
              </>
            )}
          </>
        )}
        {section === "Databases" && (
          <ConnectionDatabases config={config} onChange={onChange} />
        )}
        {section === "Advanced" && (
          <>
            <div className="form-row">
              <label>
                Connection timeout (seconds)
                <input
                  type="number"
                  min={1}
                  max={30}
                  step={1}
                  aria-label="Connection timeout (seconds)"
                  value={options.connect_timeout_secs ?? 10}
                  onChange={(event) =>
                    option({ connect_timeout_secs: Number(event.target.value) })
                  }
                />
                <small>
                  Time allowed to establish a connection: 1–30 seconds.
                </small>
              </label>
              <label>
                Query timeout (seconds)
                <input
                  type="number"
                  min={1}
                  max={3600}
                  step={1}
                  aria-label="Query timeout (seconds)"
                  value={options.query_timeout_secs ?? 30}
                  onChange={(event) =>
                    option({ query_timeout_secs: Number(event.target.value) })
                  }
                />
                <small>
                  Default time limit for new query tabs: 1–3600 seconds.
                </small>
              </label>
            </div>
            {config.driver !== "sqlite" && (
              <label>
                Maximum query sessions
                <input
                  type="number"
                  min={1}
                  max={16}
                  step={1}
                  aria-label="Maximum query sessions"
                  value={options.session_limit ?? 16}
                  onChange={(event) =>
                    option({ session_limit: Number(event.target.value) })
                  }
                />
                <small>
                  Maximum SQL tab sessions on this connection, excluding shared
                  metadata/data pools.
                </small>
              </label>
            )}
            {config.driver === "mysql" && (
              <>
                <label>
                  Client character set
                  <select
                    value={options.charset ?? ""}
                    onChange={(event) =>
                      option({ charset: event.target.value })
                    }
                  >
                    <option value="">Auto (utf8mb4)</option>
                    <option value="utf8mb4">utf8mb4</option>
                    <option value="utf8">utf8</option>
                    <option value="latin1">latin1</option>
                    <option value="ascii">ascii</option>
                  </select>
                </label>
                {path("Socket file (optional)", "socket_path")}
                <p className="connection-section-hint">
                  For a local MySQL/MariaDB server. Leave blank to use Host and
                  Port.
                </p>
              </>
            )}
            <label>
              Initial queries
              <textarea
                rows={4}
                maxLength={32000}
                aria-label="Initial queries"
                value={options.initial_queries ?? ""}
                onChange={(event) =>
                  option({ initial_queries: event.target.value })
                }
                placeholder="SET ...;"
                spellCheck={false}
              />
              <small>
                Session setup SQL. Runs on every new database connection,
                including Test connection.
              </small>
            </label>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={!!options.auto_connect}
                onChange={(event) =>
                  option({ auto_connect: event.target.checked })
                }
              />
              Auto connect at startup
            </label>
          </>
        )}
        {section === "SSL" && (
          <>
            <label>
              SSL mode
              <select
                value={config.ssl_mode}
                onChange={(event) =>
                  onSsl(event.target.value as ConnectionConfig["ssl_mode"])
                }
              >
                <option value="verify-full">
                  Verify certificate &amp; hostname (recommended)
                </option>
                <option value="require">
                  Encrypt only, no certificate check
                </option>
                <option value="disable">Disable (local development)</option>
              </select>
            </label>
            {config.ssl_mode === "require" && (
              <p className="connection-section-hint">
                Traffic is encrypted; the server certificate is not verified.
              </p>
            )}
            <fieldset
              className="connection-certificate-fields"
              disabled={config.ssl_mode === "disable"}
            >
              {path("CA certificate (optional)", "ssl_ca")}
              <div className="form-row">
                {path("Client certificate (optional)", "ssl_cert")}
                {path("Client key (optional)", "ssl_key")}
              </div>
              <p className="connection-section-hint">
                Use PEM files. Client certificate and key must be provided
                together when required by the server.
              </p>
            </fieldset>
          </>
        )}
        {section === "SSH" && (
          <>
            <label className="checkbox">
              <input
                type="checkbox"
                checked={!!ssh.enabled}
                onChange={(event) =>
                  changeSsh({ enabled: event.target.checked })
                }
              />
              Use SSH tunnel
            </label>
            <p className="connection-section-hint">
              The database Host and Port in General are reached from the SSH
              server. SSH credentials are separate from your database
              credentials.
            </p>
            <fieldset
              className="connection-certificate-fields"
              disabled={!ssh.enabled}
            >
              <div className="form-row">
                <label>
                  SSH host
                  <input
                    aria-label="SSH host"
                    value={ssh.host ?? ""}
                    onChange={(event) =>
                      changeSsh({ host: event.target.value })
                    }
                    placeholder="ssh.example.com"
                  />
                </label>
                <label className="port">
                  SSH port
                  <input
                    aria-label="SSH port"
                    type="number"
                    min={1}
                    max={65535}
                    value={ssh.port ?? 22}
                    onChange={(event) =>
                      changeSsh({ port: Number(event.target.value) })
                    }
                  />
                </label>
              </div>
              <label>
                SSH username
                <input
                  aria-label="SSH username"
                  value={ssh.username ?? ""}
                  autoComplete="off"
                  onChange={(event) =>
                    changeSsh({ username: event.target.value })
                  }
                />
              </label>
              <label>
                Authentication method
                <select
                  value={ssh.auth ?? "password"}
                  onChange={(event) =>
                    changeSsh({
                      auth: event.target.value as "password" | "private_key",
                      password: "",
                    })
                  }
                >
                  <option value="password">Password</option>
                  <option value="private_key">Private key</option>
                </select>
              </label>
              {ssh.auth === "private_key" && (
                <label>
                  Private key file
                  <input
                    aria-label="Private key file"
                    value={ssh.private_key ?? ""}
                    onChange={(event) =>
                      changeSsh({ private_key: event.target.value })
                    }
                    placeholder="/absolute/path/id_ed25519"
                    spellCheck={false}
                  />
                </label>
              )}
              <label>
                {ssh.auth === "private_key"
                  ? "Key passphrase (optional)"
                  : "SSH password"}
                <input
                  aria-label={
                    ssh.auth === "private_key"
                      ? "Key passphrase (optional)"
                      : "SSH password"
                  }
                  type="password"
                  autoComplete="new-password"
                  value={ssh.password ?? ""}
                  placeholder={
                    mode === "edit"
                      ? "Leave unchanged to keep saved secret"
                      : undefined
                  }
                  onChange={(event) =>
                    changeSsh({ password: event.target.value })
                  }
                />
              </label>
              <label>
                Host key fingerprint (optional)
                <input
                  aria-label="Host key fingerprint (optional)"
                  value={ssh.fingerprint ?? ""}
                  onChange={(event) =>
                    changeSsh({ fingerprint: event.target.value })
                  }
                  placeholder="SHA256:…"
                  spellCheck={false}
                />
                <small>
                  Leave blank to verify against ~/.ssh/known_hosts. For a new
                  host, enter a SHA256 fingerprint obtained from your server
                  administrator.
                </small>
              </label>
            </fieldset>
          </>
        )}
        {section === "Remarks" && (
          <label>
            Connection remarks
            <textarea
              rows={8}
              maxLength={4000}
              aria-label="Connection remarks"
              value={options.remarks ?? ""}
              onChange={(event) => option({ remarks: event.target.value })}
              placeholder="Purpose, environment, owner, or other notes about this connection…"
            />
            <small>Saved locally with this connection profile.</small>
          </label>
        )}
      </div>
    </>
  );
}
