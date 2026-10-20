import type { ConnectionConfig } from "../types";
export const connectionColors = [
  "#f16b72",
  "#f4c950",
  "#fff195",
  "#76d5a4",
  "#62c4e8",
  "#b698ee",
  "#a8b8c2",
];
export interface ConnectionAppearance {
  starred?: boolean;
  color?: string;
  group?: string;
}
export function readConnectionAppearance(
  raw: string | null,
): Record<string, ConnectionAppearance> {
  try {
    const parsed = JSON.parse(raw || "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed))
      return {};
    return Object.fromEntries(
      Object.entries(parsed)
        .slice(0, 500)
        .flatMap(([id, value]) => {
          if (!value || typeof value !== "object") return [];
          const data = value as ConnectionAppearance;
          return [
            [
              id,
              {
                starred: data.starred === true,
                color: connectionColors.includes(data.color ?? "")
                  ? data.color
                  : undefined,
                group:
                  typeof data.group === "string"
                    ? data.group.trim().slice(0, 60)
                    : "",
              },
            ],
          ];
        }),
    );
  } catch {
    return {};
  }
}
export const flushCommands = {
  Privileges: "FLUSH PRIVILEGES;",
  Tables: "FLUSH TABLES;",
  Logs: "FLUSH LOGS;",
  Status: "FLUSH STATUS;",
};
export function duplicateConnection(
  config: ConnectionConfig,
): ConnectionConfig {
  // A duplicate has its own vault entry. The original stored secret is never exposed.
  return {
    ...config,
    id: crypto.randomUUID(),
    name: `${config.name} copy`,
    password: "",
    ...(config.options?.ssh
      ? {
          options: {
            ...config.options,
            ssh: { ...config.options.ssh, password: "" },
          },
        }
      : {}),
  };
}
