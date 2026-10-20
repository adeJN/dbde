// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { act, cleanup, renderHook } from "@testing-library/react";
import type { PointerEvent } from "react";
import useColumnResize from "./useColumnResize";
const key = "dbde.test.column-widths";
beforeEach(() => {
  const saved = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (name: string) => saved.get(name) ?? null,
    setItem: (name: string, value: string) => saved.set(name, value),
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function pointer(x: number) {
  return {
    button: 0,
    clientX: x,
    pointerId: 1,
    preventDefault: vi.fn(),
    stopPropagation: vi.fn(),
    currentTarget: { setPointerCapture: vi.fn() },
  } as unknown as PointerEvent<HTMLElement>;
}
it("drags only the selected column, clamps at 300 and restores it after remount", () => {
  const { result, unmount } = renderHook(() => useColumnResize(key, [96, 180]));
  act(() => result.current.begin(pointer(100), 1));
  act(() =>
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 150 })),
  );
  expect(result.current.widths).toEqual([96, 230]);
  act(() =>
    window.dispatchEvent(new MouseEvent("pointermove", { clientX: 800 })),
  );
  expect(result.current.widths).toEqual([96, 300]);
  act(() => window.dispatchEvent(new MouseEvent("pointerup")));
  expect(result.current.resizing).toBe(false);
  unmount();
  const reopened = renderHook(() => useColumnResize(key, [96, 120]));
  expect(reopened.result.current.widths).toEqual([96, 300]);
});
it("restores automatic size and keeps custom sizes separate by table", () => {
  const { result, rerender } = renderHook(
    ({ storage }) => useColumnResize(storage, [100, 180]),
    { initialProps: { storage: key } },
  );
  act(() => result.current.change(0, 20));
  expect(result.current.widths).toEqual([96, 180]);
  act(() => result.current.change(0, 220));
  rerender({ storage: `${key}.other` });
  expect(result.current.widths).toEqual([100, 180]);
  rerender({ storage: key });
  expect(result.current.widths).toEqual([220, 180]);
  act(() => result.current.change(0));
  expect(result.current.widths).toEqual([100, 180]);
});
it("ignores malformed stored data", () => {
  window.localStorage.setItem(key, "not-json");
  const { result } = renderHook(() => useColumnResize(key, [96, 150]));
  expect(result.current.widths).toEqual([96, 150]);
});
