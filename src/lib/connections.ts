import type { ConnectionConfig } from "../types";

/** Identity of a server/file and its browsing scope, independent of the profile label. */
export function connectionKey(config: ConnectionConfig): string {
  const options = config.options ?? {};
  const ssh = options.ssh;
  const settings = [
    options.connect_timeout_secs ?? 10,
    options.query_timeout_secs ?? 30,
    options.session_limit ?? 16,
    options.initial_queries ?? "",
    options.ssl_ca ?? "",
    options.ssl_cert ?? "",
    options.ssl_key ?? "",
    config.driver === "mysql" ? options.charset || "utf8mb4" : "",
    config.driver === "mysql" ? (options.socket_path ?? "") : "",
    ssh?.enabled
      ? [
          ssh.host?.trim().toLowerCase(),
          ssh.port ?? 22,
          ssh.username,
          ssh.auth ?? "password",
          ssh.private_key ?? "",
          ssh.fingerprint ?? "",
        ]
      : null,
  ];
  if (config.driver === "sqlite") {
    const path = config.file_path.trim();
    // Separate in-memory profiles intentionally represent separate databases.
    return JSON.stringify([
      "sqlite",
      path,
      path === ":memory:" ? config.id : "",
      settings,
    ]);
  }
  return JSON.stringify([
    config.driver,
    config.host.trim().toLowerCase(),
    config.port,
    config.username,
    config.ssl_mode,
    configuredDatabases(config)
      ?.map((name) => name.trim())
      .sort() ?? "",
    settings,
  ]);
}

export function withoutSecrets(config: ConnectionConfig): ConnectionConfig {
  const clean = { ...config, password: undefined };
  if (config.options?.ssh)
    clean.options = {
      ...config.options,
      ssh: { ...config.options.ssh, password: undefined },
    };
  return clean;
}

/** A browsing preference, not a database permission boundary. */
export function configuredDatabases(
  config?: ConnectionConfig,
): string[] | undefined {
  if (!config || config.driver === "sqlite") return undefined;
  if (config.options?.custom_database_list)
    return (config.options.database_list ?? []).map((entry) => entry.name);
  if (config.database_only) return [config.database];
  return undefined;
}
