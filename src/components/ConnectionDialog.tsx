import mysqlLogo from "../assets/database/mysql.svg";
import postgresqlLogo from "../assets/database/postgresql.svg";
import sqliteLogo from "../assets/database/sqlite.svg";
import { useAutoDismiss } from "../hooks/useAutoDismiss";
import { useEffect, useRef, useState } from "react";
import { Database, X, ShieldCheck, Loader2, CheckCircle2 } from "lucide-react";
import type { ConnectionConfig, Driver } from "../types";
import * as api from "../lib/api";
import { withoutSecrets } from "../lib/connections";
import { useWorkspace } from "../store";
import ConnectionSettings, {
  type ConnectionSection,
} from "./ConnectionSettings";
const isLocalHost = (host: string) =>
  /^(localhost|127(\.\d{1,3}){3}|::1|\[::1\])$/i.test(host.trim());
// Encryption on loopback adds nothing; anything remote verifies the certificate.
const defaultSsl = (
  driver: Driver,
  host: string,
): ConnectionConfig["ssl_mode"] =>
  driver === "sqlite" || isLocalHost(host) ? "disable" : "verify-full";
export default function ConnectionDialog({
  onClose,
  onConnected,
  initialConfig,
  mode = "create",
  onSubmit,
}: {
  initialConfig?: ConnectionConfig;
  mode?: "create" | "edit" | "duplicate";
  onSubmit?: (config: ConnectionConfig, save: boolean) => Promise<void>;
  onClose: () => void;
  onConnected: (id: string, config: ConnectionConfig) => void;
}) {
  const [config, setConfig] = useState<ConnectionConfig>(() =>
    initialConfig
      ? {
          ...initialConfig,
          ...(initialConfig.database_only &&
          !initialConfig.options?.custom_database_list
            ? {
                database_only: false,
                options: {
                  ...initialConfig.options,
                  custom_database_list: true,
                  database_list: [
                    { name: initialConfig.database, auto_open: true },
                  ],
                },
              }
            : {}),
        }
      : {
          id: crypto.randomUUID(),
          name: "",
          driver: "postgres",
          host: "localhost",
          port: 5432,
          username: "postgres",
          password: "",
          database: "",
          database_only: false,
          ssl_mode: "disable",
          file_path: "",
        },
  );
  const [section, setSection] = useState<ConnectionSection>("General");
  const [sslChosen, setSslChosen] = useState(!!initialConfig);
  const [busy, setBusy] = useState("");
  const [message, setMessage] = useState("");
  const [success, setSuccess] = useState(false);
  const messageDismiss = useAutoDismiss(
    message,
    () => {
      setMessage("");
      setSuccess(false);
    },
    success,
  );
  const [save, setSave] = useState(true);
  const root = useRef<HTMLElement>(null);
  useEffect(() => {
    const previous = document.activeElement as HTMLElement;
    root.current?.querySelector<HTMLInputElement>("input")?.focus();
    return () => {
      if (previous?.isConnected) previous.focus();
    };
  }, []);
  function change(patch: Partial<ConnectionConfig>) {
    setConfig((c) => {
      const next = { ...c, ...patch };
      if (!sslChosen && patch.ssl_mode === undefined)
        next.ssl_mode = defaultSsl(next.driver, next.host);
      return next;
    });
    setMessage("");
  }
  function driver(driver: Driver) {
    if (
      driver === "sqlite" &&
      (section === "SSL" || section === "Databases" || section === "SSH")
    )
      setSection("General");
    change({
      options: {
        ...config.options,
        socket_path: "",
        charset: "",
        ...(driver === "sqlite"
          ? {
              custom_database_list: false,
              ssh: { ...config.options?.ssh, enabled: false },
            }
          : {}),
      },
      ...(driver === "sqlite" ? { ssl_mode: "disable" as const } : {}),
      driver,
      port: driver === "mysql" ? 3306 : 5432,
      username: driver === "mysql" ? "root" : "postgres",
    });
  }
  async function action(test: boolean) {
    if (busy) return;
    setBusy(test ? "test" : "connect");
    setMessage("");
    setSuccess(false);
    let id: string | undefined;
    try {
      const connection = {
        ...config,
        database:
          config.database.trim() ||
          (config.options?.custom_database_list
            ? (config.options.database_list?.[0]?.name.trim() ?? "")
            : ""),
        database_only: config.driver !== "sqlite" && !!config.database_only,
      };
      if (
        !config.name.trim() ||
        (config.driver === "sqlite"
          ? !config.file_path.trim()
          : !config.host.trim() ||
            !config.username.trim() ||
            !Number.isInteger(config.port) ||
            config.port < 1 ||
            config.port > 65535)
      ) {
        setSection("General");
        throw new Error("Complete the connection name and database details.");
      }
      if (connection.database_only && !connection.database) {
        setSection("Databases");
        throw new Error("Enter the database name to focus this connection.");
      }
      const options = connection.options ?? {};
      if (
        options.custom_database_list &&
        (!options.database_list?.length ||
          options.database_list.length > 256 ||
          options.database_list.some(
            (entry) =>
              !entry.name.trim() ||
              entry.name.length > 256 ||
              entry.name.includes("\0"),
          ) ||
          new Set(options.database_list.map((entry) => entry.name.trim()))
            .size !== options.database_list.length)
      ) {
        setSection("Databases");
        throw new Error(
          "Select at least one database. Use up to 256 unique database names.",
        );
      }
      if (options.database_list)
        connection.options = {
          ...options,
          database_list: options.database_list.map((entry) => ({
            ...entry,
            name: entry.name.trim(),
          })),
        };

      if (
        (options.connect_timeout_secs != null &&
          (!Number.isInteger(options.connect_timeout_secs) ||
            options.connect_timeout_secs < 1 ||
            options.connect_timeout_secs > 30)) ||
        (options.query_timeout_secs != null &&
          (!Number.isInteger(options.query_timeout_secs) ||
            options.query_timeout_secs < 1 ||
            options.query_timeout_secs > 3600)) ||
        (options.session_limit != null &&
          (!Number.isInteger(options.session_limit) ||
            options.session_limit < 1 ||
            options.session_limit > 16))
      ) {
        setSection("Advanced");
        throw new Error(
          "Use a connection timeout of 1–30 seconds, query timeout of 1–3600 seconds, and session limit of 1–16.",
        );
      }
      if (
        config.driver !== "sqlite" &&
        config.ssl_mode !== "disable" &&
        !!options.ssl_cert !== !!options.ssl_key
      ) {
        setSection("SSL");
        throw new Error("Provide both the client certificate and client key.");
      }
      const ssh = options.ssh;
      if (
        ssh?.enabled &&
        (!ssh.host?.trim() ||
          !ssh.username?.trim() ||
          !Number.isInteger(ssh.port ?? 22) ||
          (ssh.port ?? 22) < 1 ||
          (ssh.port ?? 22) > 65535 ||
          (ssh.auth === "private_key" && !ssh.private_key?.trim()) ||
          (!!ssh.fingerprint &&
            !/^SHA256:[A-Za-z0-9+/]{43}$/.test(ssh.fingerprint.trim())) ||
          !!options.socket_path)
      ) {
        setSection("SSH");
        throw new Error(
          "Complete SSH host, port and username, provide a private key when selected, and use a valid SHA256 fingerprint. Clear the local socket path in Advanced when using SSH.",
        );
      }
      if (!test && options.auto_connect && !save)
        throw new Error(
          "Save the connection to enable auto connect at startup.",
        );
      if (test) {
        await api.testConnection(connection);
        setSuccess(true);
        setMessage("Connection verified. Ready to connect.");
      } else if (onSubmit) {
        await onSubmit(connection, save);
        onClose();
      } else {
        id = await api.connect(connection);
        if (save) await api.saveProfile(connection);
        onConnected(id, withoutSecrets(connection));
        onClose();
      }
    } catch (error) {
      // Reusing an active connection must not disconnect its open tabs when saving a profile fails.
      if (
        id &&
        !useWorkspace.getState().sessions.some((session) => session.id === id)
      )
        await api.disconnect(id).catch(() => {});
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
        className="modal connection-modal"
        ref={root}
        onKeyDown={(event) => {
          if (event.key === "Escape" && !busy) onClose();
          if (event.key === "Tab") {
            const items = Array.from(
              root.current?.querySelectorAll<HTMLElement>(
                "button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled)",
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
        <h2 id="connection-title">
          {mode === "edit"
            ? "Edit Connection"
            : mode === "duplicate"
              ? "Duplicate Connection"
              : "Connect your database"}
        </h2>
        <p>A new home for your data. All connections stay on your device.</p>
        <div className="driver-options">
          {(["postgres", "mysql", "sqlite"] as Driver[]).map((d) => (
            <button
              key={d}
              type="button"
              aria-pressed={config.driver === d}
              className={config.driver === d ? "selected" : ""}
              onClick={() => driver(d)}
              disabled={!!busy}
            >
              <span className="connection-driver-logo" aria-hidden="true">
                <img
                  src={
                    d === "postgres"
                      ? postgresqlLogo
                      : d === "mysql"
                        ? mysqlLogo
                        : sqliteLogo
                  }
                  alt=""
                  width={26}
                  height={26}
                />
              </span>
              <span>
                {d === "postgres"
                  ? "PostgreSQL"
                  : d === "mysql"
                    ? "MySQL"
                    : "SQLite"}
              </span>
            </button>
          ))}
        </div>
        <form
          noValidate
          onSubmit={(e) => {
            e.preventDefault();
            void action(false);
          }}
        >
          <fieldset className="connection-form-fields" disabled={!!busy}>
            <ConnectionSettings
              config={config}
              section={section}
              onSection={setSection}
              onChange={change}
              mode={mode}
              initialConfig={initialConfig}
              onSsl={(ssl_mode) => {
                setSslChosen(true);
                change({ ssl_mode });
              }}
            />
            <label className="checkbox">
              <input
                type="checkbox"
                checked={save}
                disabled={mode === "duplicate" || !!busy}
                onChange={(e) => setSave(e.target.checked)}
              />{" "}
              {mode === "duplicate"
                ? "Save duplicate to this device"
                : "Save connection to this device"}
            </label>
            <div className="security-note">
              <ShieldCheck size={16} /> Passwords are stored in your OS
              credential vault.
            </div>
            {message && (
              <div
                {...messageDismiss}
                role={success ? "status" : "alert"}
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
                {mode === "edit"
                  ? "Save changes"
                  : mode === "duplicate"
                    ? "Save duplicate"
                    : "Connect database"}
              </button>
            </footer>
          </fieldset>
        </form>
      </section>
    </div>
  );
}
