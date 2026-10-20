// @vitest-environment jsdom
import { beforeEach, afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import useTabDrag from "./useTabDrag";

beforeEach(() => {
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

function setup() {
  const reorder = vi.fn(),
    activate = vi.fn();
  function Strip() {
    const drag = useTabDrag(reorder, activate);
    return (
      <div role="tablist" ref={drag.strip} onClickCapture={drag.click}>
        {["one", "two", "three"].map((id) => (
          <div
            data-tab-id={id}
            key={id}
            onPointerDown={(event) => drag.begin(event, id)}
            data-drop={
              drag.drop?.target === id ? String(drag.drop.after) : undefined
            }
          >
            <button role="tab" onClick={() => activate(id)}>
              {id}
            </button>
            <button className="tab-close">Close {id}</button>
          </div>
        ))}
      </div>
    );
  }
  const view = render(<Strip />);
  vi.spyOn(
    screen.getByRole("tablist"),
    "getBoundingClientRect",
  ).mockReturnValue({
    left: 0,
    right: 320,
    top: 0,
    bottom: 40,
    width: 320,
    height: 40,
  } as DOMRect);
  screen.getAllByRole("tab").forEach((tab, index) =>
    vi.spyOn(tab.parentElement!, "getBoundingClientRect").mockReturnValue({
      left: index * 100,
      right: (index + 1) * 100,
      top: 0,
      bottom: 40,
      width: 100,
      height: 40,
    } as DOMRect),
  );
  return { reorder, activate, view };
}
it("scrolls overflowing tabs with mouse wheel and trackpad without intercepting zoom", () => {
  setup();
  const strip = screen.getByRole("tablist");
  Object.defineProperties(strip, {
    clientWidth: { value: 320 },
    scrollWidth: { value: 900 },
  });
  fireEvent.wheel(strip, { deltaY: 100 });
  expect(strip.scrollLeft).toBe(100);
  fireEvent.wheel(strip, { deltaX: -50 });
  expect(strip.scrollLeft).toBe(50);
  fireEvent.wheel(strip, { deltaY: 2, deltaMode: 1 });
  expect(strip.scrollLeft).toBe(82);
  fireEvent.wheel(strip, { deltaY: 100, ctrlKey: true });
  expect(strip.scrollLeft).toBe(82);
  fireEvent.wheel(strip, { deltaY: 1000 });
  expect(strip.scrollLeft).toBe(580);
  fireEvent.wheel(document.body, { deltaY: -100 });
  expect(strip.scrollLeft).toBe(580);
});
it("drags a tab to the last position with a visible insertion marker", () => {
  const { reorder, activate } = setup();
  fireEvent.pointerDown(screen.getByRole("tab", { name: "one" }), {
    button: 0,
    clientX: 40,
    clientY: 20,
  });
  fireEvent.pointerMove(window, { clientX: 290, clientY: 20 });
  expect(document.body.classList.contains("tab-dragging")).toBe(true);
  const preview = document.querySelector<HTMLElement>(".tab-drag-preview");
  expect(preview?.getAttribute("aria-hidden")).toBe("true");
  expect(preview?.textContent).toContain("one");
  expect(preview?.style.transform).toBe("translate3d(250px, 34px, 0)");
  expect(
    screen.getByRole("tab", { name: "three" }).parentElement?.dataset.drop,
  ).toBe("true");
  fireEvent.pointerUp(window, { clientX: 290, clientY: 20 });
  expect(reorder).toHaveBeenCalledWith("one", "three", true);
  expect(activate).toHaveBeenCalledWith("one");
  expect(document.body.classList.contains("tab-dragging")).toBe(false);
  expect(document.querySelector(".tab-drag-preview")).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "three" }));
  expect(activate).toHaveBeenCalledTimes(1);
});
it("preserves ordinary clicks and ignores the close button", () => {
  const { reorder, activate } = setup();
  const tab = screen.getByRole("tab", { name: "one" });
  fireEvent.pointerDown(tab, { button: 0, clientX: 40, clientY: 20 });
  fireEvent.pointerMove(window, { clientX: 42, clientY: 20 });
  fireEvent.pointerUp(window, { clientX: 42, clientY: 20 });
  fireEvent.click(tab);
  expect(activate).toHaveBeenCalledWith("one");
  fireEvent.pointerDown(screen.getByRole("button", { name: "Close one" }), {
    button: 0,
    clientX: 80,
    clientY: 20,
  });
  fireEvent.pointerMove(window, { clientX: 290, clientY: 20 });
  fireEvent.pointerUp(window, { clientX: 290, clientY: 20 });
  expect(reorder).not.toHaveBeenCalled();
});
it("cancels drops outside the strip and cleans up interrupted drags", () => {
  const { reorder, view } = setup();
  const tab = screen.getByRole("tab", { name: "one" });
  fireEvent.pointerDown(tab, { button: 0, clientX: 40, clientY: 20 });
  fireEvent.pointerMove(window, { clientX: 290, clientY: 100 });
  fireEvent.pointerUp(window, { clientX: 290, clientY: 100 });
  expect(reorder).not.toHaveBeenCalled();
  fireEvent.pointerDown(tab, { button: 0, clientX: 40, clientY: 20 });
  fireEvent.pointerMove(window, { clientX: 290, clientY: 20 });
  view.unmount();
  expect(document.body.classList.contains("tab-dragging")).toBe(false);
  expect(document.querySelector(".tab-drag-preview")).toBeNull();
});
