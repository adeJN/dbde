// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import DatabaseObjectError from "./DatabaseObjectError";
import { databaseUpgradeIssue } from "../lib/database-errors";
afterEach(cleanup);
const error =
  "error returned from database: 1558 (HY000): Column count of mysql.proc is wrong. Expected 21, found 20. Created with MariaDB 100108, now running 100428. Please use mysql_upgrade to fix this error";
it("explains the MariaDB server mismatch, retains details and retries only on click", () => {
  const retry = vi.fn();
  render(<DatabaseObjectError error={error} onRetry={retry} />);
  expect(
    screen.getByText("MariaDB system tables need an upgrade"),
  ).toBeTruthy();
  expect(
    screen.getByText(/created for MariaDB 10.1.8.*running 10.4.28/),
  ).toBeTruthy();
  expect(screen.getByText(error)).toBeTruthy();
  expect(retry).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  expect(retry).toHaveBeenCalledOnce();
});
it("keeps unrelated errors intact without suggesting a server upgrade", () => {
  expect(databaseUpgradeIssue("Access denied for user root")).toBeUndefined();
  render(
    <DatabaseObjectError
      error="Access denied for user root"
      onRetry={() => {}}
      compact
    />,
  );
  expect(screen.getByText("Access denied for user root")).toBeTruthy();
  expect(screen.queryByText("Technical details")).toBeNull();
});
