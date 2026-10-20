// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import ErdCanvas from "./ErdCanvas";
import type { ModelTable } from "../lib/database-model";
const tables: ModelTable[] = [
  {
    table: { name: "contents", schema: "app", kind: "table" },
    columns: Array.from({ length: 12 }, (_, i) => ({
      name: `field_${i}`,
      data_type: "varchar(255)",
      nullable: true,
    })),
    indexes: [
      { name: "PRIMARY", primary: true, unique: true, columns: ["field_0"] },
    ],
    keys: [],
    x: 48,
    y: 48,
  },
  {
    table: { name: "menu", schema: "app", kind: "table" },
    columns: [{ name: "id", data_type: "integer", nullable: false }],
    indexes: [],
    keys: [],
    x: 500,
    y: 48,
  },
];
beforeEach(() => {
  vi.stubGlobal("PointerEvent", MouseEvent);
  vi.stubGlobal("requestAnimationFrame", (fn: FrameRequestCallback) => {
    fn(0);
    return 1;
  });
  Object.defineProperty(HTMLElement.prototype, "setPointerCapture", {
    configurable: true,
    value: () => {},
  });
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});
function Harness() {
  const [items, setItems] = useState(tables),
    [selected, setSelected] = useState(0);
  return (
    <ErdCanvas
      tables={items}
      selected={selected}
      onSelect={setSelected}
      onChange={setItems}
      onInspect={() => {}}
    />
  );
}
it("shows all fields and PK icon, supports search and bounded zoom controls", () => {
  render(<Harness />);
  expect(screen.getByText("field_11")).toBeTruthy();
  expect(screen.getByLabelText("Primary key")).toBeTruthy();
  expect(screen.getByRole("img", { name: /Diagram minimap/ })).toBeTruthy();
  fireEvent.change(screen.getByRole("textbox", { name: "Search diagram" }), {
    target: { value: "menu" },
  });
  expect(screen.getByText("1 matches")).toBeTruthy();
  expect(
    screen
      .getByRole("button", { name: "Move table contents" })
      .closest("section")
      ?.classList.contains("dimmed"),
  ).toBe(true);
  fireEvent.change(screen.getByRole("slider", { name: "Diagram zoom" }), {
    target: { value: "150" },
  });
  expect(
    screen.getByRole("button", { name: "Reset diagram zoom" }).textContent,
  ).toBe("150%");
});
it("moves tables using keyboard and pointer coordinates corrected for zoom", () => {
  render(<Harness />);
  const header = screen.getByRole("button", { name: "Move table contents" });
  fireEvent.keyDown(header, { key: "ArrowRight", shiftKey: true });
  expect(header.closest("section")?.style.left).toBe("72px");
  fireEvent.change(screen.getByRole("slider", { name: "Diagram zoom" }), {
    target: { value: "200" },
  });
  fireEvent.pointerDown(header, {
    button: 0,
    clientX: 100,
    clientY: 100,
    pointerId: 1,
  });
  fireEvent.pointerMove(window, { clientX: 140, clientY: 120, pointerId: 1 });
  fireEvent.pointerUp(header, { pointerId: 1 });
  expect(header.closest("section")?.style.left).toBe("92px");
  expect(header.closest("section")?.style.top).toBe("58px");
});
