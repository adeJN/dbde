// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  act,
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import AppUpdater from "./AppUpdater";
import { useWorkspace } from "../store";
import {
  checkUpdate,
  desktopUpdates,
  installUpdate,
  updateStatus,
} from "../lib/updater";
vi.mock("../lib/updater", async (original) => ({
  ...(await original<typeof import("../lib/updater")>()),
  desktopUpdates: vi.fn(() => true),
  updateStatus: vi.fn(),
  checkUpdate: vi.fn(),
  installUpdate: vi.fn(),
}));
beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(desktopUpdates).mockReturnValue(true);
  vi.mocked(updateStatus).mockResolvedValue({
    currentVersion: "0.2.0",
    configured: true,
  });
  vi.mocked(checkUpdate).mockResolvedValue({
    version: "0.3.0",
    currentVersion: "0.2.0",
    notes: "Faster tables\nBetter imports",
  });
  useWorkspace.setState({ sessions: [], tabs: [] });
});
afterEach(cleanup);
const open = () => {
  render(<AppUpdater />);
  fireEvent.click(screen.getByRole("button", { name: "App updates" }));
};
it("checks manually and displays release notes as text", async () => {
  open();
  expect(await screen.findByText("DBde 0.3.0 is available")).toBeTruthy();
  expect(screen.getByText(/Faster tables/).textContent).toContain(
    "Better imports",
  );
  expect(checkUpdate).toHaveBeenCalledOnce();
  expect(
    (
      screen.getByRole("button", {
        name: /Download & install/,
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});
it("blocks installation while a database connection is open", async () => {
  useWorkspace.setState({ sessions: [{ id: "local" } as never] });
  open();
  await screen.findByText("DBde 0.3.0 is available");
  const button = screen.getByRole("button", { name: /Download & install/ });
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(installUpdate).not.toHaveBeenCalled();
});
it("reports no update and restores focus on closing", async () => {
  vi.mocked(checkUpdate).mockResolvedValue(null);
  open();
  await screen.findByText("You’re up to date.");
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.queryByRole("dialog")).toBeNull();
  expect(document.activeElement).toBe(
    screen.getByRole("button", { name: "App updates" }),
  );
});
it("shows retry after a failed check", async () => {
  vi.mocked(checkUpdate).mockRejectedValueOnce("GitHub unavailable");
  open();
  expect(await screen.findByRole("alert")).toHaveProperty(
    "textContent",
    "GitHub unavailable",
  );
  fireEvent.click(screen.getByRole("button", { name: "Retry" }));
  await screen.findByText("DBde 0.3.0 is available");
});
it("shows download progress and keeps the dialog open during installation", async () => {
  let reject!: (error: Error) => void;
  vi.mocked(installUpdate).mockImplementation((progress) => {
    progress({ event: "download", downloaded: 5, total: 10 });
    return new Promise<void>((_, fail) => {
      reject = fail;
    });
  });
  open();
  await screen.findByText("DBde 0.3.0 is available");
  fireEvent.click(screen.getByRole("button", { name: /Download & install/ }));
  expect(await screen.findByText("Downloading update… 50%")).toBeTruthy();
  fireEvent.keyDown(window, { key: "Escape" });
  expect(screen.getByRole("dialog")).toBeTruthy();
  await act(async () => reject(new Error("Signature rejected")));
  await waitFor(() =>
    expect(screen.getByRole("alert").textContent).toContain(
      "Signature rejected",
    ),
  );
  expect(
    (screen.getByRole("button", { name: "Later" }) as HTMLButtonElement)
      .disabled,
  ).toBe(false);
});
it("browser sandbox explains desktop updates without calling native check", async () => {
  vi.mocked(desktopUpdates).mockReturnValue(false);
  vi.mocked(updateStatus).mockResolvedValue({
    currentVersion: "0.2.0",
    configured: false,
  });
  open();
  await screen.findByText("Install the desktop app to receive updates.");
  expect(checkUpdate).not.toHaveBeenCalled();
});
