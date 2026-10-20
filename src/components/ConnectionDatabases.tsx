import { useEffect, useRef, useState } from "react";
import { Plus, Minus, RefreshCw, Database, Loader2 } from "lucide-react";
import type { ConnectionConfig } from "../types";
import * as api from "../lib/api";
import { connectionKey } from "../lib/connections";

export default function ConnectionDatabases({
  config,
  onChange,
}: {
  config: ConnectionConfig;
  onChange: (patch: Partial<ConnectionConfig>) => void;
}) {
  const options = config.options ?? {};
  const enabled = !!options.custom_database_list;
  const entries = options.database_list ?? [];
  const [catalog, setCatalog] = useState<string[]>([]);
  const [selected, setSelected] = useState("");
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState("");
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState("");
  const generation = useRef(0);
  const latest = useRef(config);
  latest.current = config;
  // Ignore responses from previous server details or an unmounted panel.
  const serverKey = connectionKey({
    ...config,
    database_only: false,
    options: { ...options, custom_database_list: false, database_list: [] },
  });
  useEffect(() => {
    generation.current++;
    setCatalog([]);
    setLoading(false);
    setError("");
    return () => {
      generation.current++;
    };
  }, [serverKey, config.database, config.password, options.ssh?.password]);
  function update(list: typeof entries) {
    onChange({
      database_only: false,
      options: { ...options, database_list: list },
    });
  }
  async function refresh() {
    const current = ++generation.current;
    setLoading(true);
    setError("");
    try {
      const databases = await api.discoverDatabases(latest.current);
      if (current === generation.current)
        setCatalog([...new Set(databases)].sort());
    } catch (cause) {
      if (current === generation.current) setError(String(cause));
    } finally {
      if (current === generation.current) setLoading(false);
    }
  }
  function add() {
    const value = name.trim();
    if (!value) {
      setError("Enter a database name.");
      return;
    }
    if (entries.some((entry) => entry.name === value)) {
      setSelected(value);
      setError("This database is already in the custom list.");
      return;
    }
    update([...entries, { name: value, auto_open: false }]);
    setSelected(value);
    setName("");
    setAdding(false);
    setError("");
  }
  const names = [
    ...new Set([...catalog, ...entries.map((entry) => entry.name)]),
  ].sort();
  return (
    <div className="connection-databases">
      <label className="checkbox">
        <input
          type="checkbox"
          checked={enabled}
          onChange={(event) =>
            onChange({
              database_only: false,
              options: {
                ...options,
                custom_database_list: event.target.checked,
              },
            })
          }
        />
        Use custom database list
      </label>
      <p className="connection-section-hint" id="database-list-help">
        {enabled
          ? "Select the databases to show. Auto Open expands their tables when connecting."
          : "All databases available to this account will be shown."}
      </p>
      <div
        className={`connection-database-list${enabled ? "" : " is-disabled"}`}
      >
        <table
          aria-label="Custom database list"
          aria-describedby="database-list-help"
        >
          <thead>
            <tr>
              <th
                className="database-include-heading"
                aria-label="Show database"
              />
              <th>Name</th>
              <th className="database-auto-heading">Auto Open</th>
            </tr>
          </thead>
          <tbody>
            {names.map((database) => {
              const entry = entries.find((item) => item.name === database);
              return (
                <tr
                  key={database}
                  className={selected === database ? "is-selected" : ""}
                  onClick={() => setSelected(database)}
                >
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Show ${database}`}
                      checked={!!entry}
                      disabled={!enabled}
                      onChange={(event) => {
                        setError("");
                        update(
                          event.target.checked
                            ? [...entries, { name: database, auto_open: false }]
                            : entries.filter((item) => item.name !== database),
                        );
                      }}
                    />
                  </td>
                  <td>
                    <button
                      type="button"
                      className="database-list-name"
                      onClick={() => setSelected(database)}
                      title={database}
                      disabled={!enabled}
                    >
                      <Database size={14} />
                      <span>{database}</span>
                    </button>
                  </td>
                  <td>
                    <input
                      type="checkbox"
                      aria-label={`Auto Open ${database}`}
                      checked={!!entry?.auto_open}
                      disabled={!enabled || !entry}
                      onChange={(event) =>
                        update(
                          entries.map((item) =>
                            item.name === database
                              ? { ...item, auto_open: event.target.checked }
                              : item,
                          ),
                        )
                      }
                    />
                  </td>
                </tr>
              );
            })}
            {!names.length && (
              <tr>
                <td colSpan={3} className="database-list-empty">
                  <Database size={25} />
                  <span>
                    {enabled
                      ? "Choose which databases appear"
                      : "Custom database list is off"}
                  </span>
                  <small>
                    {enabled
                      ? "Refresh to load databases, or add a database by name."
                      : "Enable the custom list to choose databases."}
                  </small>
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
      <div
        className="connection-database-tools"
        role="group"
        aria-label="Database list actions"
      >
        <button
          type="button"
          className="tiny-button"
          title="Add database to list"
          aria-label="Add database to list"
          disabled={!enabled}
          onClick={() => {
            setAdding(!adding);
            setError("");
          }}
        >
          <Plus size={16} />
        </button>
        <button
          type="button"
          className="tiny-button"
          title="Remove selected database from list"
          aria-label="Remove selected database from list"
          disabled={!enabled || !selected}
          onClick={() => {
            update(entries.filter((entry) => entry.name !== selected));
            setCatalog((old) => old.filter((item) => item !== selected));
            setSelected("");
          }}
        >
          <Minus size={16} />
        </button>
        <button
          type="button"
          className="tiny-button"
          title="Refresh database list"
          aria-label="Refresh database list"
          disabled={!enabled || loading}
          onClick={() => void refresh()}
        >
          {loading ? (
            <Loader2 size={16} className="spin" />
          ) : (
            <RefreshCw size={16} />
          )}
        </button>
        <span aria-live="polite">
          {loading ? "Loading databases…" : `${entries.length} selected`}
        </span>
      </div>
      {adding && enabled && (
        <div className="database-list-add">
          <input
            aria-label="Database name to add"
            autoFocus
            value={name}
            placeholder="Database name"
            maxLength={256}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") {
                event.preventDefault();
                add();
              }
              if (event.key === "Escape") {
                event.preventDefault();
                event.stopPropagation();
                setAdding(false);
              }
            }}
          />
          <button type="button" className="secondary-button" onClick={add}>
            Add
          </button>
        </div>
      )}
      {error && (
        <p className="error-text" role="alert">
          {error}
        </p>
      )}
      <label>
        Initial database (optional)
        <input
          aria-label="Initial database (optional)"
          value={config.database}
          onChange={(event) => onChange({ database: event.target.value })}
          placeholder={
            enabled
              ? "Defaults to the first selected database"
              : "Leave blank to browse all databases"
          }
        />
        <small>
          The database used for the first connection. This does not add it to
          the custom display list.
        </small>
      </label>
    </div>
  );
}
