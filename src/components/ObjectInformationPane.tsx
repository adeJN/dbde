import { useEffect, useState } from "react";
import * as api from "../lib/api";
import type { IndexInfo, Session, TableInfo, TableMetadata } from "../types";
export default function ObjectInformationPane({
  session,
  database,
  table,
  onClose,
}: {
  session: Session;
  database: string;
  table: TableInfo;
  onClose?: () => void;
}) {
  const [data, setData] = useState<{
      ddl: string;
      indexes: IndexInfo[];
      meta?: TableMetadata;
    }>(),
    [error, setError] = useState("");
  useEffect(() => {
    let active = true;
    setData(undefined);
    setError("");
    void Promise.all([
      api.tableDdl(session.id, table, database),
      api.listIndexes(session.id, table, database),
      api.schema(session.id, database),
    ])
      .then(async ([ddl, indexes, tree]) => {
        let meta = tree.table_metadata?.find(
          (t) => t.name === table.name && t.schema === table.schema,
        );
        if (session.config.driver === "sqlite") {
          const page = await api.viewTable(session.id, database, table, 1, 1);
          if (
            page.source?.primary_keys.length &&
            !indexes.some((index) => index.primary)
          )
            indexes.unshift({
              name: "PRIMARY",
              columns: page.source.primary_keys,
              primary: true,
              unique: true,
            });
          meta = {
            name: table.name,
            schema: table.schema,
            rows: page.pagination?.total_rows ?? null,
            data_length: null,
            engine: "SQLite",
            created_date: null,
            modified_date: null,
            collation: null,
            comment: null,
          };
        }
        if (active) setData({ ddl, indexes, meta });
      })
      .catch((e) => {
        if (active) setError(String(e));
      });
    return () => {
      active = false;
    };
  }, [session.id, database, table.name, table.schema]);
  return (
    <aside className="object-information" aria-label="Object information">
      <header>
        <strong>{table.name}</strong>
        {onClose && (
          <button
            className="button subtle"
            onClick={onClose}
            aria-label="Close object information"
          >
            ×
          </button>
        )}
      </header>
      {error && <p role="alert">{error}</p>}
      {!data && !error && <p role="status">Loading object information…</p>}
      {data && (
        <>
          <dl>
            {[
              ["Database", database],
              ["Schema", table.schema],
              ["Kind", table.kind],
              [
                "Rows (estimate)",
                data.meta?.rows?.toLocaleString() ?? "Unavailable",
              ],
              [
                "Data size",
                data.meta?.data_length == null
                  ? "Unavailable"
                  : `${data.meta.data_length.toLocaleString()} bytes`,
              ],
              ["Engine", data.meta?.engine ?? session.config.driver],
              ["Collation", data.meta?.collation ?? "—"],
              ["Comment", data.meta?.comment ?? "—"],
            ].map(([name, value]) => (
              <div key={name}>
                <dt>{name}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
          <h4>Indexes</h4>
          {data.indexes.length ? (
            data.indexes.map((i) => (
              <p key={i.name}>
                <strong>{i.name}</strong> ·{" "}
                {i.primary ? "Primary" : i.unique ? "Unique" : "Index"}
                <br />
                {i.columns.join(", ")}
              </p>
            ))
          ) : (
            <p>No secondary indexes reported.</p>
          )}
          <h4>DDL</h4>
          <pre className="admin-sql">{data.ddl}</pre>
        </>
      )}
    </aside>
  );
}
