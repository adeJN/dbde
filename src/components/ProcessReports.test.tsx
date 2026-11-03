// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  cleanup,
  act,
  fireEvent,
  render,
  screen,
  within,
} from "@testing-library/react";
import ProcessReports from "./ProcessReports";
import { useProcessReports } from "../lib/process-reports";
const { copy } = vi.hoisted(() => ({
  copy: vi.fn().mockResolvedValue(undefined),
}));
vi.mock("../lib/clipboard", () => ({ writeClipboard: copy }));
beforeEach(() => {
  useProcessReports.setState({
    reports: [],
    notifications: [],
    selectedId: undefined,
    open: false,
  });
  copy.mockClear();
});
afterEach(cleanup);
it("reopens completed reports, exposes log details and copies the report", async () => {
  const store = useProcessReports.getState();
  const id = store.start("Copy table", "source → target");
  store.progress(id, "Copying records", 300);
  store.finish(id, "success", "Table copied");
  render(<ProcessReports />);
  expect(screen.queryByRole("region", { name: "Process reports" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: /Lihat log/ }));
  const panel = screen.getByRole("region", { name: "Process reports" });
  expect(within(panel).getByRole("status").textContent).toContain(
    "Table copied",
  );
  fireEvent.click(within(panel).getByRole("button", { name: "Copy log" }));
  await screen.findByRole("button", { name: "Log copied" });
  expect(copy.mock.calls[0][0]).toContain("Rows: 300");
  fireEvent.click(
    screen.getByRole("button", { name: "Close process reports" }),
  );
  expect(screen.queryByRole("region", { name: "Process reports" })).toBeNull();
  fireEvent.click(screen.getByRole("button", { name: "Process reports" }));
  expect(screen.getByRole("region", { name: "Process reports" })).toBeTruthy();
  fireEvent.click(
    screen.getByRole("button", { name: "Clear completed reports" }),
  );
  expect(useProcessReports.getState().reports).toHaveLength(0);
});

it("auto-dismisses successful feedback after five seconds but retains errors", () => {
  vi.useFakeTimers();
  try {
    const store = useProcessReports.getState();
    store.notify("Saved", "success");
    store.notify("Permission denied", "error");
    render(<ProcessReports />);
    expect(screen.getByText("Saved")).toBeTruthy();
    act(() => vi.advanceTimersByTime(5000));
    expect(screen.queryByText("Saved")).toBeNull();
    expect(screen.getByRole("alert").textContent).toContain(
      "Permission denied",
    );
    fireEvent.click(screen.getByRole("button", { name: "Dismiss error" }));
    expect(screen.queryByRole("alert")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
it("pauses the success timer while hovered and opens the corresponding report", () => {
  vi.useFakeTimers();
  try {
    const store = useProcessReports.getState();
    const id = store.start("Export");
    store.finish(id, "success", "Finished");
    store.notify("Exported successfully", "success", id);
    expect(useProcessReports.getState().notifications).toHaveLength(1);
    render(<ProcessReports />);
    fireEvent.mouseEnter(screen.getByRole("status"));
    act(() => vi.advanceTimersByTime(10000));
    expect(screen.getByText("Exported successfully")).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /Lihat log/ }));
    expect(useProcessReports.getState().selectedId).toBe(id);
    expect(
      screen.getByRole("region", { name: "Process reports" }),
    ).toBeTruthy();
    expect(screen.queryByText("Exported successfully")).toBeNull();
  } finally {
    vi.useRealTimers();
  }
});
it("keeps a partial-success warning visible until dismissed", () => {
  vi.useFakeTimers();
  try {
    useProcessReports.getState().notify("2 inserted · 1 failed", "warning");
    render(<ProcessReports />);
    act(() => vi.advanceTimersByTime(60000));
    expect(screen.getByRole("alert").textContent).toContain(
      "Selesai dengan peringatan",
    );
    expect(screen.getByRole("button", { name: /Lihat log/ })).toBeTruthy();
  } finally {
    vi.useRealTimers();
  }
});
