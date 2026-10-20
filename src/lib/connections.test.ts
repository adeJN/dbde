import { beforeEach, describe, expect, it } from "vitest";
import { connectionKey, configuredDatabases } from "./connections";
import { useWorkspace } from "../store";
import type { ConnectionConfig } from "../types";
const config: ConnectionConfig = {
  id: "local",
  name: "Local",
  driver: "mysql",
  host: "localhost",
  port: 3306,
  username: "root",
  ssl_mode: "disable",
  database: "",
  file_path: "",
};
beforeEach(() =>
  useWorkspace.setState({ sessions: [], tabs: [], activeTab: "" }),
);
describe("connection identity", () => {
  it("reuses the server across profile names and initial databases, without storing passwords in its key", () => {
    expect(
      connectionKey({ ...config, host: " LOCALHOST ", password: "secret" }),
    ).toBe(
      connectionKey({
        ...config,
        id: "alias",
        name: "Other name",
        database: "app",
      }),
    );
    expect(connectionKey({ ...config, password: "secret" })).not.toContain(
      "secret",
    );
    for (const changed of [
      { port: 3307 },
      { username: "reader" },
      { ssl_mode: "require" as const },
      { driver: "postgres" as const },
      { host: "remote" },
    ])
      expect(connectionKey({ ...config, ...changed })).not.toBe(
        connectionKey(config),
      );
  });
  it("keeps focused databases distinct while deduplicating the same focused database", () => {
    const focused = { ...config, database: "app", database_only: true };
    expect(connectionKey(focused)).not.toBe(
      connectionKey({ ...focused, database_only: false }),
    );
    expect(connectionKey(focused)).not.toBe(
      connectionKey({ ...focused, database: "other" }),
    );
    expect(connectionKey(focused)).toBe(
      connectionKey({
        ...focused,
        id: "alias",
        name: "Alias",
        database: " app ",
      }),
    );
    useWorkspace.getState().addSession({ id: "all", config });
    useWorkspace.getState().addSession({ id: "focused", config: focused });
    useWorkspace
      .getState()
      .addSession({ id: "duplicate", config: { ...focused, id: "alias" } });
    expect(useWorkspace.getState().sessions.map((s) => s.id)).toEqual([
      "all",
      "focused",
    ]);
  });
  it("normalizes defaults while separating socket, SSL and session settings", () => {
    expect(
      connectionKey({
        ...config,
        options: { remarks: "Note", auto_connect: true },
      }),
    ).toBe(connectionKey(config));
    expect(
      connectionKey({
        ...config,
        options: {
          connect_timeout_secs: 10,
          query_timeout_secs: 30,
          session_limit: 16,
          charset: "utf8mb4",
        },
      }),
    ).toBe(connectionKey(config));
    for (const options of [
      { socket_path: "/tmp/other.sock" },
      { ssl_ca: "/cert.pem" },
      { initial_queries: "SET @test = 1" },
      { session_limit: 2 },
    ])
      expect(connectionKey({ ...config, options })).not.toBe(
        connectionKey(config),
      );
  });
  it("preserves an active sidebar session, loaded trees and tabs when the same server is added again", () => {
    const session = {
      id: "active",
      config,
      databases: ["app"],
      trees: { app: { database: "app", tables: [] } },
    };
    useWorkspace.getState().addSession(session);
    useWorkspace.setState({
      tabs: [
        {
          id: "query",
          name: "Pending work",
          connectionId: "active",
          query: "BEGIN",
          running: false,
        },
      ],
      activeTab: "query",
    });
    useWorkspace.getState().addSession({
      id: "duplicate",
      config: { ...config, id: "alias", database: "app", name: "Alias" },
    });
    useWorkspace.getState().addSession({ id: "active", config });
    expect(useWorkspace.getState().sessions).toEqual([session]);
    expect(useWorkspace.getState().tabs[0].query).toBe("BEGIN");
    expect(useWorkspace.getState().activeTab).toBe("query");
  });
  it("keeps distinct SQLite files and independent in-memory profiles separate", () => {
    const sqlite = {
      ...config,
      driver: "sqlite" as const,
      file_path: "/data/app.db",
    };
    expect(connectionKey(sqlite)).toBe(
      connectionKey({ ...sqlite, id: "alias" }),
    );
    expect(connectionKey(sqlite)).not.toBe(
      connectionKey({ ...sqlite, file_path: "/data/other.db" }),
    );
    expect(connectionKey({ ...sqlite, file_path: ":memory:" })).not.toBe(
      connectionKey({ ...sqlite, id: "other", file_path: ":memory:" }),
    );
  });
});
it("distinguishes SSH routes without including SSH secrets", () => {
  const tunneled: ConnectionConfig = {
    ...config,
    options: {
      ssh: {
        enabled: true,
        host: "jump.example.test",
        username: "deploy",
        password: "ssh-secret",
      },
    },
  };
  expect(connectionKey(tunneled)).not.toEqual(connectionKey(config));
  expect(connectionKey(tunneled)).not.toContain("ssh-secret");
  expect(connectionKey(tunneled)).not.toEqual(
    connectionKey({
      ...tunneled,
      options: {
        ssh: { ...tunneled.options?.ssh, host: "other.example.test" },
      },
    }),
  );
});

it("uses only custom databases and preserves the legacy focused scope", () => {
  const custom = {
    ...config,
    options: {
      custom_database_list: true,
      database_list: [
        { name: "app", auto_open: true },
        { name: "analytics", auto_open: false },
      ],
    },
  };
  expect(configuredDatabases(custom)).toEqual(["app", "analytics"]);
  expect(connectionKey(custom)).toEqual(
    connectionKey({
      ...custom,
      options: {
        ...custom.options,
        database_list: custom.options.database_list.map((entry) => ({
          ...entry,
          auto_open: !entry.auto_open,
        })),
      },
    }),
  );
  expect(
    connectionKey({ ...config, database_only: true, database: "app" }),
  ).toEqual(
    connectionKey({
      ...config,
      options: {
        custom_database_list: true,
        database_list: [{ name: "app", auto_open: false }],
      },
    }),
  );

  expect(
    configuredDatabases({ ...config, database_only: true, database: "legacy" }),
  ).toEqual(["legacy"]);
  expect(configuredDatabases(config)).toBeUndefined();
  expect(connectionKey(custom)).not.toEqual(connectionKey(config));
  expect(connectionKey(custom)).toEqual(
    connectionKey({
      ...custom,
      options: {
        ...custom.options,
        database_list: [...custom.options.database_list].reverse(),
      },
    }),
  );
});
