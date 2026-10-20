// @vitest-environment jsdom
import { StrictMode } from "react";
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import ServerMonitor from "./ServerMonitor";
import * as api from "../lib/api";
vi.mock("../lib/api", () => ({ execute: vi.fn() }));
afterEach(() => {
  cleanup();
  vi.clearAllMocks();
});
const session = {
  id: "server",
  config: {
    id: "profile",
    name: "Test",
    driver: "mysql" as const,
    host: "localhost",
    port: 3306,
    username: "root",
    database: "app",
    ssl_mode: "disable" as const,
    file_path: "",
  },
};
it("loads under StrictMode and cancels a selected query only after explicit confirmation", async () => {
  vi.mocked(api.execute).mockResolvedValue({
    columns: ["Id", "User", "Info"],
    rows: [[123, "reader", "SELECT 1"]],
    affected_rows: 0,
    execution_ms: 0,
    truncated: false,
  });
  render(
    <StrictMode>
      <ServerMonitor session={session} database="app" />
    </StrictMode>,
  );
  await screen.findByText("SELECT 1");
  fireEvent.click(screen.getByText("123"));
  const kill = screen.getByRole("button", { name: "Kill query" });
  expect((kill as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(
    screen.getByRole("checkbox", { name: "Cancel this server query" }),
  );
  fireEvent.click(kill);
  await waitFor(() =>
    expect(api.execute).toHaveBeenCalledWith(
      "server",
      "KILL QUERY 123;",
      "app",
    ),
  );
});
