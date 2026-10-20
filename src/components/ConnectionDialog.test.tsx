// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import ConnectionDialog from "./ConnectionDialog";
import { useWorkspace } from "../store";
const api = vi.hoisted(() => ({
  connect: vi.fn(),
  testConnection: vi.fn(),
  discoverDatabases: vi.fn(),
  saveProfile: vi.fn(),
  disconnect: vi.fn(),
}));
vi.mock("../lib/api", () => api);
beforeEach(() => {
  vi.resetAllMocks();
  api.connect.mockResolvedValue("focused-session");
  api.testConnection.mockResolvedValue(true);
  api.saveProfile.mockResolvedValue(undefined);
  useWorkspace.setState({ sessions: [], tabs: [], activeTab: "" });
});
afterEach(cleanup);
function dialog() {
  const onConnected = vi.fn();
  render(<ConnectionDialog onClose={vi.fn()} onConnected={onConnected} />);
  fireEvent.click(screen.getByRole("button", { name: "MySQL" }));
  fireEvent.change(screen.getByRole("textbox", { name: "Connection name" }), {
    target: { value: "App DB" },
  });
  fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
  return onConnected;
}
function addDatabase(name: string) {
  fireEvent.click(screen.getByRole("button", { name: "Add database to list" }));
  fireEvent.change(
    screen.getByRole("textbox", { name: "Database name to add" }),
    { target: { value: name } },
  );
  fireEvent.click(screen.getByRole("button", { name: "Add" }));
}
it("requires a selected database when the custom list is enabled", async () => {
  dialog();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Use custom database list" }),
  );
  fireEvent.click(screen.getByRole("button", { name: /Test connection/ }));
  expect(await screen.findByText(/Select at least one database/)).toBeTruthy();
  expect(api.testConnection).not.toHaveBeenCalled();
});
it("persists multiple display databases and their auto-open preferences", async () => {
  const onConnected = dialog();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Use custom database list" }),
  );
  addDatabase(" app_db ");
  addDatabase("analytics");
  fireEvent.click(screen.getByRole("checkbox", { name: "Auto Open app_db" }));
  fireEvent.click(screen.getByRole("button", { name: "Connect database" }));
  await waitFor(() =>
    expect(onConnected).toHaveBeenCalledWith(
      "focused-session",
      expect.objectContaining({
        database: "app_db",
        database_only: false,
        options: expect.objectContaining({
          custom_database_list: true,
          database_list: [
            { name: "app_db", auto_open: true },
            { name: "analytics", auto_open: false },
          ],
        }),
      }),
    ),
  );
  expect(api.saveProfile).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({ custom_database_list: true }),
    }),
  );
});
it("refreshes database choices without selecting all or overwriting preferences", async () => {
  api.discoverDatabases.mockResolvedValue(["app_db", "analytics", "mysql"]);
  dialog();
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Use custom database list" }),
  );
  addDatabase("app_db");
  fireEvent.click(screen.getByRole("checkbox", { name: "Auto Open app_db" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Refresh database list" }),
  );
  expect(
    await screen.findByRole("checkbox", { name: "Show analytics" }),
  ).toBeTruthy();
  expect(
    (
      screen.getByRole("checkbox", {
        name: "Show analytics",
      }) as HTMLInputElement
    ).checked,
  ).toBe(false);
  expect(
    (
      screen.getByRole("checkbox", {
        name: "Auto Open app_db",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  fireEvent.click(screen.getByRole("checkbox", { name: "Show analytics" }));
  fireEvent.click(
    screen.getByRole("button", { name: "Remove selected database from list" }),
  );
  expect(screen.queryByRole("checkbox", { name: "Show analytics" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Test connection/ }));
  await waitFor(() =>
    expect(api.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        options: expect.objectContaining({
          database_list: [{ name: "app_db", auto_open: true }],
        }),
      }),
    ),
  );
});
it("keeps an initial database separate from focus mode", async () => {
  const onConnected = dialog();
  fireEvent.change(screen.getByRole("textbox", { name: /Initial database/ }), {
    target: { value: "app_db" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect database" }));
  await waitFor(() =>
    expect(onConnected).toHaveBeenCalledWith(
      "focused-session",
      expect.objectContaining({ database: "app_db", database_only: false }),
    ),
  );
});
it("preserves settings across tabs and submits advanced, SSL and remarks options", async () => {
  dialog();
  fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Query timeout (seconds)" }),
    { target: { value: "90" } },
  );
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Maximum query sessions" }),
    { target: { value: "4" } },
  );
  fireEvent.change(
    screen.getByRole("textbox", { name: "Socket file (optional)" }),
    { target: { value: "/tmp/mysql.sock" } },
  );
  fireEvent.click(screen.getByRole("tab", { name: "SSL" }));
  fireEvent.change(screen.getByRole("combobox", { name: "SSL mode" }), {
    target: { value: "verify-full" },
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: "CA certificate (optional)" }),
    { target: { value: "/certs/ca.pem" } },
  );
  fireEvent.click(screen.getByRole("tab", { name: "Remarks" }));
  fireEvent.change(
    screen.getByRole("textbox", { name: "Connection remarks" }),
    { target: { value: "Local app database" } },
  );
  fireEvent.click(screen.getByRole("button", { name: /Test connection/ }));
  await waitFor(() =>
    expect(api.testConnection).toHaveBeenCalledWith(
      expect.objectContaining({
        name: "App DB",
        ssl_mode: "verify-full",
        options: expect.objectContaining({
          query_timeout_secs: 90,
          session_limit: 4,
          socket_path: "/tmp/mysql.sock",
          ssl_ca: "/certs/ca.pem",
          remarks: "Local app database",
        }),
      }),
    ),
  );
});
it("blocks invalid advanced values and incomplete SSL client credentials", async () => {
  dialog();
  fireEvent.click(screen.getByRole("tab", { name: "Advanced" }));
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Connection timeout (seconds)" }),
    { target: { value: "0" } },
  );
  fireEvent.click(screen.getByRole("button", { name: /Test connection/ }));
  expect(await screen.findByText(/Use a connection timeout/)).toBeTruthy();
  expect(api.testConnection).not.toHaveBeenCalled();
  fireEvent.change(
    screen.getByRole("spinbutton", { name: "Connection timeout (seconds)" }),
    { target: { value: "10" } },
  );
  fireEvent.click(screen.getByRole("tab", { name: "SSL" }));
  fireEvent.change(screen.getByRole("combobox", { name: "SSL mode" }), {
    target: { value: "require" },
  });
  fireEvent.change(
    screen.getByRole("textbox", { name: "Client certificate (optional)" }),
    { target: { value: "/client.pem" } },
  );
  fireEvent.click(screen.getByRole("button", { name: /Test connection/ }));
  expect(
    await screen.findByText(/Provide both the client certificate/),
  ).toBeTruthy();
  expect(api.testConnection).not.toHaveBeenCalled();
});
it("validates SSH settings and keeps the secret out of workspace config", async () => {
  const onConnected = dialog();
  fireEvent.click(screen.getByRole("tab", { name: "SSH" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Use SSH tunnel" }));
  fireEvent.click(screen.getByRole("button", { name: /Test connection/ }));
  expect(await screen.findByText(/Complete SSH host/)).toBeTruthy();
  expect(api.testConnection).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "SSH host" }), {
    target: { value: "ssh.example.test" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "SSH username" }), {
    target: { value: "deploy" },
  });
  fireEvent.change(screen.getByLabelText("SSH password"), {
    target: { value: "ssh-secret" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Connect database" }));
  await waitFor(() => expect(onConnected).toHaveBeenCalled());
  expect(api.connect).toHaveBeenCalledWith(
    expect.objectContaining({
      options: expect.objectContaining({
        ssh: expect.objectContaining({ enabled: true, password: "ssh-secret" }),
      }),
    }),
  );
  expect(onConnected.mock.calls[0][1].options.ssh.password).toBeUndefined();
});
it("requires a key file when private key authentication is selected", async () => {
  dialog();
  fireEvent.click(screen.getByRole("tab", { name: "SSH" }));
  fireEvent.click(screen.getByRole("checkbox", { name: "Use SSH tunnel" }));
  fireEvent.change(screen.getByRole("textbox", { name: "SSH host" }), {
    target: { value: "ssh.example.test" },
  });
  fireEvent.change(screen.getByRole("textbox", { name: "SSH username" }), {
    target: { value: "deploy" },
  });
  fireEvent.change(
    screen.getByRole("combobox", { name: "Authentication method" }),
    { target: { value: "private_key" } },
  );
  fireEvent.click(screen.getByRole("button", { name: /Test connection/ }));
  expect(await screen.findByText(/Complete SSH host/)).toBeTruthy();
  expect(api.testConnection).not.toHaveBeenCalled();
  fireEvent.change(screen.getByRole("textbox", { name: "Private key file" }), {
    target: { value: "/keys/id_ed25519" },
  });
  fireEvent.click(screen.getByRole("button", { name: /Test connection/ }));
  await waitFor(() => expect(api.testConnection).toHaveBeenCalled());
});

it("migrates a legacy single-database profile to a one-entry custom list", () => {
  render(
    <ConnectionDialog
      mode="edit"
      initialConfig={{
        id: "legacy",
        name: "Legacy",
        driver: "mysql",
        host: "localhost",
        port: 3306,
        username: "root",
        database: "shop",
        database_only: true,
        ssl_mode: "disable",
        file_path: "",
      }}
      onClose={vi.fn()}
      onConnected={vi.fn()}
    />,
  );
  fireEvent.click(screen.getByRole("tab", { name: "Databases" }));
  expect(
    (
      screen.getByRole("checkbox", {
        name: "Use custom database list",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
  expect(
    (screen.getByRole("checkbox", { name: "Show shop" }) as HTMLInputElement)
      .checked,
  ).toBe(true);
  expect(
    (
      screen.getByRole("checkbox", {
        name: "Auto Open shop",
      }) as HTMLInputElement
    ).checked,
  ).toBe(true);
});
