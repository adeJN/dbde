// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ResizableSidebar from "./ResizableSidebar";

let saved: Map<string, string>;
beforeEach(() => {
  saved = new Map();
  vi.stubGlobal("innerWidth", 1440);
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => saved.get(key) ?? null,
    setItem: (key: string, value: string) => saved.set(key, value),
  });
  vi.stubGlobal(
    "PointerEvent",
    class extends MouseEvent {
      pointerId: number;
      constructor(type: string, options: PointerEventInit = {}) {
        super(type, options);
        this.pointerId = options.pointerId ?? 1;
      }
    },
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

it("supports keyboard resizing, saves the width, and resets it", () => {
  const view = render(<ResizableSidebar>Explorer</ResizableSidebar>);
  const handle = screen.getByRole("separator", { name: "Resize sidebar" });
  fireEvent.keyDown(handle, { key: "ArrowRight", shiftKey: true });
  expect(handle.getAttribute("aria-valuenow")).toBe("264");
  expect(saved.get("dbde.sidebar-width")).toBe("264");
  view.unmount();
  render(<ResizableSidebar>Explorer</ResizableSidebar>);
  const restored = screen.getByRole("separator");
  expect(restored.getAttribute("aria-valuenow")).toBe("264");
  fireEvent.doubleClick(restored);
  expect(restored.getAttribute("aria-valuenow")).toBe("224");
});

it("drags within bounds and restores page interaction on cancellation or unmount", () => {
  const view = render(<ResizableSidebar>Explorer</ResizableSidebar>);
  const handle = screen.getByRole("separator");
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 224 });
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 350 });
  expect(handle.getAttribute("aria-valuenow")).toBe("350");
  fireEvent.pointerMove(window, { pointerId: 2, clientX: 500 });
  expect(handle.getAttribute("aria-valuenow")).toBe("350");
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 2000 });
  expect(handle.getAttribute("aria-valuenow")).toBe("560");
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 0 });
  expect(handle.getAttribute("aria-valuenow")).toBe("180");
  fireEvent.pointerCancel(window, { pointerId: 1 });
  expect(document.body.style.userSelect).toBe("");
  fireEvent.pointerMove(window, { pointerId: 1, clientX: 500 });
  expect(handle.getAttribute("aria-valuenow")).toBe("180");
  fireEvent.pointerDown(handle, { button: 0, pointerId: 1, clientX: 180 });
  expect(document.body.style.cursor).toBe("col-resize");
  view.unmount();
  expect(document.body.style.cursor).toBe("");
});

it("fits a smaller window and restores the preferred width when space returns", () => {
  saved.set("dbde.sidebar-width", "500");
  render(<ResizableSidebar>Explorer</ResizableSidebar>);
  const handle = screen.getByRole("separator");
  vi.stubGlobal("innerWidth", 375);
  fireEvent.resize(window);
  expect(handle.getAttribute("aria-valuenow")).toBe("300");
  vi.stubGlobal("innerWidth", 1440);
  fireEvent.resize(window);
  expect(handle.getAttribute("aria-valuenow")).toBe("500");
});
