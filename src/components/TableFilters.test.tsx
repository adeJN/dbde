// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TableFilters from "./TableFilters";
afterEach(cleanup);
it("applies OR connectors and retains them when reopening saved filters", () => {
  const onApply = vi.fn();
  const props = { columns: ["name"], busy: false, onApply, onClose: vi.fn() };
  const { rerender } = render(<TableFilters {...props} applied={[]} />);
  fireEvent.change(screen.getByLabelText("Filter value 1"), {
    target: { value: "alpha" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
  fireEvent.change(screen.getByLabelText("Filter connector 2"), {
    target: { value: "or" },
  });
  fireEvent.change(screen.getByLabelText("Filter value 2"), {
    target: { value: "beta" },
  });
  fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
  expect(onApply.mock.calls[0][0]).toEqual([
    { column: "name", operator: "contains", value: "alpha" },
    { column: "name", operator: "contains", value: "beta", join: "or" },
  ]);
  rerender(<TableFilters {...props} applied={onApply.mock.calls[0][0]} />);
  expect(
    (screen.getByLabelText("Filter connector 2") as HTMLSelectElement).value,
  ).toBe("or");
  fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
  expect(onApply).toHaveBeenLastCalledWith([]);
});
