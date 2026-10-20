import { useMemo, useState } from "react";
import { Plus } from "lucide-react";
import * as api from "../lib/api";
import {
  builderColumns,
  builderSql,
  type BuilderDesign,
} from "../lib/admin-tools";
import { modelTableKey } from "../lib/database-model";
import type { Session, TableInfo } from "../types";
export default function VisualQueryBuilder({
  session,
  database,
  tables,
  onSQL,
}: {
  session: Session;
  database: string;
  tables: TableInfo[];
  onSQL: (sql: string) => void;
}) {
  const [design, setDesign] = useState<BuilderDesign>({
    tables: [],
    joins: [],
    selected: [],
    limit: 1000,
  });
  const [columns, setColumns] = useState<Record<string, string[]>>({});
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);
  const [choice, setChoice] = useState("0");
  const fields = builderColumns(design.tables, columns);
  const preview = useMemo(() => {
    try {
      return {
        sql: builderSql(session.config.driver, design, columns),
        error: "",
      };
    } catch (e) {
      return { sql: "", error: String(e) };
    }
  }, [session.config.driver, design, columns]);
  async function add(table: TableInfo) {
    if (
      loading ||
      design.tables.some((t) => modelTableKey(t) === modelTableKey(table))
    )
      return;
    setLoading(true);
    setError("");
    try {
      const info = await api.columns(session.id, table, database);
      setColumns((old) => ({
        ...old,
        [modelTableKey(table)]: info.map((c) => c.name),
      }));
      setDesign((old) => ({
        ...old,
        tables: [...old.tables, table],
        joins: old.tables.length
          ? [...old.joins, { table, left: "", right: "", kind: "LEFT" }]
          : [],
      }));
    } catch (e) {
      setError(String(e));
    } finally {
      setLoading(false);
    }
  }
  return (
    <div className="admin-builder">
      <div className="admin-row">
        <select
          aria-label="Table to add"
          value={choice}
          onChange={(e) => setChoice(e.target.value)}
        >
          {tables.map((t, i) => (
            <option key={modelTableKey(t)} value={i}>
              {t.schema ? `${t.schema}.` : ""}
              {t.name}
            </option>
          ))}
        </select>
        <button
          className="button"
          disabled={loading || !tables.length}
          onClick={() => void add(tables[Number(choice)])}
        >
          <Plus size={14} /> Add table
        </button>
        <button
          className="button subtle"
          onClick={() =>
            setDesign({ tables: [], joins: [], selected: [], limit: 1000 })
          }
        >
          Clear
        </button>
      </div>
      <p className="admin-muted">
        Drag a table from this list onto the canvas, or use Add table. Choose
        join fields and output columns below.
      </p>
      <div className="builder-palette">
        {tables.map((t) => (
          <button
            key={modelTableKey(t)}
            draggable
            onDragStart={(e) =>
              e.dataTransfer.setData("application/dbde-table", modelTableKey(t))
            }
            onClick={() => void add(t)}
            className="button subtle"
          >
            {t.name}
          </button>
        ))}
      </div>
      <div
        className="builder-canvas"
        aria-label="Query canvas"
        onDragOver={(e) => e.preventDefault()}
        onDrop={(e) => {
          e.preventDefault();
          const t = tables.find(
            (t) =>
              modelTableKey(t) ===
              e.dataTransfer.getData("application/dbde-table"),
          );
          if (t) void add(t);
        }}
      >
        {!design.tables.length && (
          <p>Drop tables here to build a SELECT query.</p>
        )}
        {design.tables.map((t, i) => (
          <section key={modelTableKey(t)} className="builder-table">
            <strong>
              t{i + 1} · {t.name}
            </strong>
            {fields
              .filter((f) => f.table === i)
              .map((f) => (
                <label
                  key={f.id}
                  draggable
                  title="Drag this field onto a field in another table to join"
                  onDragStart={(e) => {
                    e.stopPropagation();
                    e.dataTransfer.setData("application/dbde-column", f.id);
                  }}
                  onDragOver={(e) => e.preventDefault()}
                  onDrop={(e) => {
                    e.preventDefault();
                    e.stopPropagation();
                    const from = fields.find(
                      (field) =>
                        field.id ===
                        e.dataTransfer.getData("application/dbde-column"),
                    );
                    if (!from || from.table === f.table) return;
                    const left = from.table < f.table ? from : f,
                      right = from.table < f.table ? f : from;
                    setDesign((old) => ({
                      ...old,
                      joins: old.joins.map((join, index) =>
                        index === right.table - 1
                          ? { ...join, left: left.id, right: right.id }
                          : join,
                      ),
                    }));
                    setError("");
                  }}
                >
                  <input
                    type="checkbox"
                    checked={design.selected.includes(f.id)}
                    onChange={(e) =>
                      setDesign((old) => ({
                        ...old,
                        selected: e.target.checked
                          ? [...old.selected, f.id]
                          : old.selected.filter((id) => id !== f.id),
                      }))
                    }
                  />
                  {f.name}
                </label>
              ))}
          </section>
        ))}
      </div>
      {design.joins.map((join, i) => (
        <div key={i} className="admin-row">
          <span>Join t{i + 2}</span>
          <select
            aria-label={`Join ${i + 1} type`}
            value={join.kind}
            onChange={(e) =>
              setDesign((old) => ({
                ...old,
                joins: old.joins.map((j, n) =>
                  n === i ? { ...j, kind: e.target.value as typeof j.kind } : j,
                ),
              }))
            }
          >
            {[
              "INNER",
              "LEFT",
              ...(session.config.driver !== "sqlite" ? ["RIGHT"] : []),
            ].map((v) => (
              <option key={v}>{v}</option>
            ))}
          </select>
          {(["left", "right"] as const).map((side) => (
            <select
              key={side}
              aria-label={`Join ${i + 1} ${side} column`}
              value={join[side]}
              onChange={(e) =>
                setDesign((old) => ({
                  ...old,
                  joins: old.joins.map((j, n) =>
                    n === i ? { ...j, [side]: e.target.value } : j,
                  ),
                }))
              }
            >
              <option value="">Choose {side} column…</option>
              {fields
                .filter((f) =>
                  side === "left" ? f.table <= i : f.table === i + 1,
                )
                .map((f) => (
                  <option key={f.id} value={f.id}>
                    t{f.table + 1}.{f.name}
                  </option>
                ))}
            </select>
          ))}
        </div>
      ))}
      <div className="admin-row">
        <label>
          Order by{" "}
          <select
            value={design.sort ?? ""}
            onChange={(e) =>
              setDesign((old) => ({
                ...old,
                sort: e.target.value || undefined,
              }))
            }
          >
            <option value="">None</option>
            {fields.map((f) => (
              <option value={f.id} key={f.id}>
                t{f.table + 1}.{f.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          <input
            type="checkbox"
            checked={!!design.descending}
            onChange={(e) =>
              setDesign((old) => ({ ...old, descending: e.target.checked }))
            }
          />{" "}
          Descending
        </label>
        <label>
          Limit{" "}
          <input
            type="number"
            min={1}
            max={50000}
            value={design.limit}
            onChange={(e) =>
              setDesign((old) => ({ ...old, limit: Number(e.target.value) }))
            }
          />
        </label>
      </div>
      {(error || preview.error) && (
        <p role="alert" className="error-banner">
          {error || preview.error}
        </p>
      )}
      <pre className="admin-sql">
        {preview.sql || "-- Select tables and configure joins."}
      </pre>
      <button
        className="button primary"
        disabled={!preview.sql}
        onClick={() => onSQL(preview.sql)}
      >
        Open SQL in query tab
      </button>
    </div>
  );
}
