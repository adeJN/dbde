import ErdCanvas from "./ErdCanvas";
import { arrangeErd } from "../lib/erd-layout";
import { useEffect, useState } from "react";
import { Plus, RefreshCw, Save, Upload } from "lucide-react";
import * as api from "../lib/api";
import {
  forwardModel,
  modelTableKey,
  parseModel,
  reverseDatabase,
  renameModelField,
  syncModel,
  type DatabaseModel as Model,
} from "../lib/database-model";
import type { Session } from "../types";
export default function DatabaseModel({
  session,
  database,
  onSQL,
}: {
  session: Session;
  database: string;
  onSQL: (sql: string) => void;
}) {
  const storageKey = `dbde.model:${JSON.stringify([session.config.id, database])}`;
  const [model, setModel] = useState<Model>(() => {
    try {
      const saved = localStorage.getItem(storageKey);
      if (saved) return parseModel(saved);
    } catch {}
    return { version: 1, driver: session.config.driver, database, tables: [] };
  });
  const [inspector, setInspector] = useState(false);
  const [newName, setNewName] = useState("");
  const [selected, setSelected] = useState(0),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(""),
    [message, setMessage] = useState("");
  const [relation, setRelation] = useState({
    column: "",
    table: "",
    target: "",
  });
  const current = model.tables[selected];
  async function run(task: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    setMessage("");
    try {
      await task();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  function editField(
    index: number,
    patch: Partial<Model["tables"][number]["columns"][number]>,
  ) {
    if (patch.name !== undefined) {
      setModel((old) => renameModelField(old, selected, index, patch.name!));
      return;
    }
    setModel((old) => ({
      ...old,
      tables: old.tables.map((t, i) =>
        i === selected
          ? {
              ...t,
              columns: t.columns.map((c, n) =>
                n === index ? { ...c, ...patch } : c,
              ),
            }
          : t,
      ),
    }));
  }
  useEffect(() => {
    if (model.tables.length) return;
    let active = true;
    setBusy(true);
    setError("");
    void reverseDatabase(session, database)
      .then((next) => {
        if (active) setModel({ ...next, tables: arrangeErd(next.tables) });
      })
      .catch((cause) => {
        if (active) setError(String(cause));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [session.id, database]);
  return (
    <div className="admin-model erd-model">
      <div className="admin-row model-actions">
        <div className="toolbar-group" role="group" aria-label="Model source">
          <button
            className="button"
            disabled={busy}
            title="Reload table definitions and foreign keys from the selected database"
            onClick={() =>
              void run(async () => {
                const next = await reverseDatabase(session, database);
                setModel({ ...next, tables: arrangeErd(next.tables) });
                setSelected(0);
              })
            }
          >
            <RefreshCw size={14} /> Reverse database
          </button>
          <label className="button" title="Open a DBde model JSON file">
            <Upload size={14} /> Import JSON
            <input
              aria-label="Import model"
              disabled={busy}
              type="file"
              accept=".json"
              hidden
              onChange={(e) => {
                const file = e.target.files?.[0];
                if (file)
                  void run(async () => {
                    if (file.size > 5 * 1024 * 1024)
                      throw new Error("Model files must be under 5 MB.");
                    const next = parseModel(await file.text());
                    if (next.driver !== session.config.driver)
                      throw new Error(
                        "Model engine must match the connection.",
                      );
                    setModel({
                      ...next,
                      database,
                      tables: next.tables.map((t) => ({
                        ...t,
                        table: {
                          ...t.table,
                          schema:
                            next.driver === "mysql" ? database : t.table.schema,
                        },
                        keys: t.keys.map((k) => ({
                          ...k,
                          referenced_table: {
                            ...k.referenced_table,
                            schema:
                              next.driver === "mysql" &&
                              k.referenced_table.schema === next.database
                                ? database
                                : k.referenced_table.schema,
                          },
                        })),
                      })),
                    });
                    setSelected(0);
                  });
              }}
            />
          </label>
        </div>
        <div className="toolbar-group" role="group" aria-label="Model files">
          <button
            className="button"
            disabled={busy}
            title="Save model fields and layout on this device"
            onClick={() => {
              try {
                localStorage.setItem(storageKey, JSON.stringify(model));
                setMessage("Model saved on this device.");
              } catch (e) {
                setError(String(e));
              }
            }}
          >
            <Save size={14} /> Save model
          </button>
          <button
            className="button"
            disabled={busy}
            title="Export this model as a JSON file"
            onClick={() =>
              void run(async () => {
                await api.saveFile(
                  `${database}.dbde-model.json`,
                  "json",
                  JSON.stringify(model, null, 2),
                );
              })
            }
          >
            Export JSON
          </button>
        </div>
        <div className="toolbar-group" role="group" aria-label="Model design">
          <button
            className="button"
            disabled={busy}
            title="Add a table to the model; review SQL to create it in the database"
            onClick={() => {
              setInspector(true);
              setNewName("");
            }}
          >
            <Plus size={14} /> New table
          </button>
          <button
            className={`button${inspector ? " active" : ""}`}
            aria-pressed={inspector}
            title="Show or hide model fields, relationships and SQL tools"
            disabled={busy}
            onClick={() => setInspector(!inspector)}
          >
            Fields & SQL
          </button>
        </div>
      </div>
      {error && (
        <p className="error-banner" role="alert">
          {error}
        </p>
      )}
      {message && (
        <p className="admin-message" role="status">
          {message}
        </p>
      )}
      {busy && (
        <p className="admin-muted" role="status">
          Reading database model…
        </p>
      )}
      <div className="erd-workspace">
        <ErdCanvas
          tables={model.tables}
          selected={selected}
          onSelect={setSelected}
          onChange={(tables) => setModel((old) => ({ ...old, tables }))}
          onInspect={() => setInspector(true)}
        />
        {inspector && (
          <aside className="erd-inspector" aria-label="Model inspector">
            <header>
              <strong>Fields & relationships</strong>
              <button
                className="button subtle"
                aria-label="Close model inspector"
                onClick={() => setInspector(false)}
              >
                Close
              </button>
            </header>
            <div className="admin-row">
              <input
                aria-label="New model table name"
                placeholder="New table name"
                value={newName}
                onChange={(e) => setNewName(e.target.value)}
              />
              <button
                className="button"
                disabled={busy || !newName.trim()}
                onClick={() => {
                  const name = newName;
                  if (!name?.trim()) return;
                  if (model.tables.some((t) => t.table.name === name.trim()))
                    return setError("Table already exists in the model.");
                  setModel((old) => ({
                    ...old,
                    tables: [
                      ...old.tables,
                      {
                        table: {
                          name: name.trim(),
                          schema:
                            session.config.driver === "postgres"
                              ? "public"
                              : session.config.driver === "mysql"
                                ? database
                                : "main",
                          kind: "table",
                        },
                        columns: [
                          { name: "id", data_type: "INTEGER", nullable: false },
                        ],
                        indexes: [
                          {
                            name: "PRIMARY",
                            columns: ["id"],
                            unique: true,
                            primary: true,
                          },
                        ],
                        keys: [],
                        x: 48,
                        y: Math.max(
                          48,
                          ...old.tables.map(
                            (t) => t.y + t.columns.length * 24 + 130,
                          ),
                        ),
                      },
                    ],
                  }));
                  setSelected(model.tables.length);
                  setNewName("");
                }}
              >
                <Plus size={14} /> Add model table
              </button>
              <select
                aria-label="Model table"
                value={selected}
                onChange={(e) => setSelected(Number(e.target.value))}
              >
                {model.tables.map((t, i) => (
                  <option value={i} key={i}>
                    {t.table.name}
                  </option>
                ))}
              </select>
            </div>
            {current && (
              <>
                <table className="admin-data">
                  <thead>
                    <tr>
                      <th>Field</th>
                      <th>Type</th>
                      <th>Nullable</th>
                    </tr>
                  </thead>
                  <tbody>
                    {current.columns.map((c, i) => (
                      <tr key={i}>
                        <td>
                          <input
                            aria-label={`Model field ${i + 1} name`}
                            value={c.name}
                            onChange={(e) =>
                              editField(i, { name: e.target.value })
                            }
                          />
                        </td>
                        <td>
                          <input
                            aria-label={`Model field ${i + 1} type`}
                            value={c.data_type}
                            onChange={(e) =>
                              editField(i, { data_type: e.target.value })
                            }
                          />
                        </td>
                        <td>
                          <input
                            aria-label={`Model field ${i + 1} nullable`}
                            type="checkbox"
                            checked={c.nullable}
                            onChange={(e) =>
                              editField(i, { nullable: e.target.checked })
                            }
                          />
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
                <button
                  className="button subtle"
                  onClick={() =>
                    setModel((old) => ({
                      ...old,
                      tables: old.tables.map((t, i) =>
                        i === selected
                          ? {
                              ...t,
                              columns: [
                                ...t.columns,
                                {
                                  name: `field_${t.columns.length + 1}`,
                                  data_type: "TEXT",
                                  nullable: true,
                                },
                              ],
                            }
                          : t,
                      ),
                    }))
                  }
                >
                  <Plus size={14} /> Add field
                </button>
                <div className="admin-row">
                  <span>Foreign key</span>
                  <select
                    aria-label="Foreign key field"
                    value={relation.column}
                    onChange={(e) =>
                      setRelation({ ...relation, column: e.target.value })
                    }
                  >
                    <option value="">Field…</option>
                    {current.columns.map((c) => (
                      <option key={c.name}>{c.name}</option>
                    ))}
                  </select>
                  <select
                    aria-label="Referenced model table"
                    value={relation.table}
                    onChange={(e) =>
                      setRelation({
                        ...relation,
                        table: e.target.value,
                        target: "",
                      })
                    }
                  >
                    <option value="">Referenced table…</option>
                    {model.tables.map((t, i) => (
                      <option key={i} value={String(i)}>
                        {t.table.name}
                      </option>
                    ))}
                  </select>
                  <select
                    aria-label="Referenced model field"
                    value={relation.target}
                    onChange={(e) =>
                      setRelation({ ...relation, target: e.target.value })
                    }
                  >
                    <option value="">Referenced field…</option>
                    {model.tables[Number(relation.table)]?.columns.map((c) => (
                      <option key={c.name}>{c.name}</option>
                    ))}
                  </select>
                  <button
                    className="button"
                    disabled={
                      !relation.column || !relation.table || !relation.target
                    }
                    onClick={() => {
                      const target = model.tables[Number(relation.table)];
                      setModel((old) => ({
                        ...old,
                        tables: old.tables.map((t, i) =>
                          i === selected
                            ? {
                                ...t,
                                keys: [
                                  ...t.keys,
                                  {
                                    name: `fk_${t.table.name}_${t.keys.length + 1}`,
                                    columns: [relation.column],
                                    referenced_table: target.table,
                                    referenced_columns: [relation.target],
                                  },
                                ],
                              }
                            : t,
                        ),
                      }));
                      setRelation({ column: "", table: "", target: "" });
                    }}
                  >
                    Add relation
                  </button>
                </div>
              </>
            )}
            <div className="admin-row">
              <button
                className="button primary"
                disabled={busy || !model.tables.length}
                onClick={() =>
                  void run(async () => {
                    onSQL(forwardModel(model));
                  })
                }
              >
                Forward engineering · SQL preview
              </button>
              <button
                className="button"
                disabled={busy || !model.tables.length}
                onClick={() =>
                  void run(async () => {
                    const live = await reverseDatabase(session, database);
                    const plan = syncModel(model, live);
                    setMessage(
                      plan.notes.join("\n") ||
                        "Additive synchronization: existing fields and records are retained.",
                    );
                    if (plan.sql)
                      onSQL(
                        `-- Additive model synchronization\n${plan.notes.map((n) => "-- " + n).join("\n")}\n${plan.sql}`,
                      );
                    else
                      setMessage(
                        ["No additive changes to apply.", ...plan.notes].join(
                          "\n",
                        ),
                      );
                  })
                }
              >
                Compare & sync · SQL preview
              </button>
            </div>
          </aside>
        )}
      </div>
    </div>
  );
}
