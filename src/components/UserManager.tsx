import { useEffect, useState } from "react";
import * as api from "../lib/api";
import {
  accountSql,
  grantsSql,
  PRIVILEGES,
  privilegeSql,
  roleSql,
  usersSql,
} from "../lib/admin-tools";
import { AdminResult } from "./ServerMonitor";
import { quoteIdentifier } from "../lib/sql";
import type { QueryResult, Session, TableInfo } from "../types";
export default function UserManager({
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
  const [result, setResult] = useState<QueryResult>(),
    [grants, setGrants] = useState<QueryResult>(),
    [name, setName] = useState(""),
    [host, setHost] = useState("localhost"),
    [role, setRole] = useState(""),
    [table, setTable] = useState("*"),
    [privilege, setPrivilege] = useState("SELECT"),
    [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [password, setPassword] = useState(""),
    [version, setVersion] = useState(0);
  const driver = session.config.driver;
  useEffect(() => {
    let active = true;
    if (driver === "sqlite") return;
    setBusy(true);
    void api
      .execute(session.id, usersSql(driver), database)
      .then((data) => {
        if (active) {
          setResult(data);
          setError("");
        }
      })
      .catch((e) => {
        if (active) setError(String(e));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, [session.id, database, driver, version]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  }
  const preview = (action: () => string) => {
    setError("");
    try {
      onSQL(action());
    } catch (e) {
      setError(String(e));
    }
  };
  if (driver === "sqlite")
    return (
      <p>
        SQLite has no server users, roles or GRANT statements. Access is
        controlled by permissions on the database file.
      </p>
    );
  return (
    <>
      <div className="admin-row">
        <button
          className="button"
          disabled={busy}
          onClick={() => setVersion((v) => v + 1)}
        >
          Refresh accounts
        </button>
        <span className="admin-muted">
          Account lists require administrative privileges. SQL changes open in a
          query tab for review.
        </span>
      </div>
      {busy && <p role="status">Loading accounts…</p>}
      <AdminResult
        result={result}
        onRow={(row) => {
          setName(String(row[0]));
          if (driver === "mysql") setHost(String(row[1]));
          setGrants(undefined);
        }}
      />
      <div className="admin-row">
        <label>
          User / role{" "}
          <input value={name} onChange={(e) => setName(e.target.value)} />
        </label>
        {driver === "mysql" && (
          <label>
            Host{" "}
            <input value={host} onChange={(e) => setHost(e.target.value)} />
          </label>
        )}
        <button
          className="button"
          disabled={busy || !name}
          onClick={() =>
            void run(async () =>
              setGrants(
                await api.execute(
                  session.id,
                  grantsSql(driver, name, host),
                  database,
                ),
              ),
            )
          }
        >
          Show grants
        </button>
        <button
          className="button"
          disabled={busy || !name}
          onClick={() =>
            void run(async () => {
              const account = accountSql(driver, name, host);
              setGrants(
                await api.execute(
                  session.id,
                  driver === "postgres"
                    ? `SELECT r.rolname AS role, m.rolname AS member, a.admin_option FROM pg_auth_members a JOIN pg_roles r ON r.oid = a.roleid JOIN pg_roles m ON m.oid = a.member WHERE m.rolname = ${"'" + name.replaceAll("'", "''") + "'"};`
                    : `SHOW GRANTS FOR ${account};`,
                  database,
                ),
              );
            })
          }
        >
          Role memberships
        </button>
      </div>
      <AdminResult result={grants} />
      <h3>Table privileges</h3>
      <div className="admin-row">
        <select
          aria-label="Privilege table"
          value={table}
          onChange={(e) => setTable(e.target.value)}
        >
          <option value="*">All tables</option>
          {tables.map((t, i) => (
            <option key={i} value={String(i)}>
              {t.schema}.{t.name}
            </option>
          ))}
        </select>
        <select
          aria-label="Privilege"
          value={privilege}
          onChange={(e) => setPrivilege(e.target.value)}
        >
          {PRIVILEGES.map((p) => (
            <option key={p}>{p}</option>
          ))}
        </select>
        {(["GRANT", "REVOKE"] as const).map((action) => (
          <button
            className="button"
            key={action}
            disabled={!name}
            onClick={() =>
              preview(() => {
                const t = table === "*" ? undefined : tables[Number(table)];
                return privilegeSql(
                  driver,
                  action,
                  name,
                  host,
                  database,
                  t?.schema ?? "public",
                  t?.name ?? "*",
                  privilege,
                );
              })
            }
          >
            {action} · SQL preview
          </button>
        ))}
      </div>
      <h3>Roles</h3>
      <div className="admin-row">
        <label>
          Role name{" "}
          <input value={role} onChange={(e) => setRole(e.target.value)} />
        </label>
        {(["create", "grant", "revoke"] as const).map((action) => (
          <button
            className="button"
            key={action}
            disabled={!role || (action !== "create" && !name)}
            onClick={() =>
              preview(() => roleSql(driver, action, role, name, host))
            }
          >
            {action} role · SQL preview
          </button>
        ))}
      </div>
      <h3>Create user</h3>
      <div className="admin-row">
        <label>
          New password{" "}
          <input
            type="password"
            autoComplete="new-password"
            value={password}
            onChange={(e) => setPassword(e.target.value)}
          />
        </label>
        <button
          className="button"
          disabled={busy || !name || !password}
          onClick={() =>
            void run(async () => {
              const account = accountSql(driver, name, host);
              if (password.includes("\0"))
                throw new Error("Password cannot contain NUL.");
              let literal = "";
              if (driver === "postgres") {
                let tag = "$dbde_password$";
                while (password.includes(tag)) tag = tag.slice(0, -1) + "_$";
                literal = tag + password + tag;
              } else {
                const mode = await api.execute(
                  session.id,
                  "SELECT @@SESSION.sql_mode;",
                  database,
                );
                const noEscapes = String(mode.rows[0]?.[0] ?? "")
                  .split(",")
                  .includes("NO_BACKSLASH_ESCAPES");
                literal =
                  "'" +
                  (noEscapes
                    ? password
                    : password.replaceAll("\\", "\\\\")
                  ).replaceAll("'", "''") +
                  "'";
              }
              onSQL(
                driver === "postgres"
                  ? `CREATE ROLE ${quoteIdentifier(name, driver)} LOGIN PASSWORD ${literal};`
                  : `CREATE USER ${account} IDENTIFIED BY ${literal};`,
              );
              setPassword("");
            })
          }
        >
          Create user · SQL preview
        </button>
        <button
          className="button danger"
          disabled={!name}
          onClick={() =>
            preview(
              () =>
                `DROP ${driver === "postgres" ? "ROLE" : "USER"} ${accountSql(driver, name, host)};`,
            )
          }
        >
          Delete account · SQL preview
        </button>
      </div>
      <p className="admin-muted">
        Password SQL contains a secret: it opens in an unsaved query tab. Clear
        or close that tab after use. PostgreSQL users are roles with LOGIN.
      </p>
      {error && (
        <p role="alert" className="error-banner">
          {error}
        </p>
      )}
    </>
  );
}
