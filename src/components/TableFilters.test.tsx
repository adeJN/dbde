// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TableFilters from "./TableFilters";
afterEach(cleanup);
describe("table filter builder", () => {
  it("applies a database sort from the Filter & Sort panel", () => {
    const onSortChange = vi.fn();
    render(
      <TableFilters
        columns={["id", "name"]}
        applied={[]}
        busy={false}
        onApply={vi.fn()}
        onClose={vi.fn()}
        onSortChange={onSortChange}
      />,
    );
    fireEvent.change(screen.getByRole("combobox", { name: "Sort column" }), {
      target: { value: "name" },
    });
    fireEvent.change(screen.getByRole("combobox", { name: "Sort direction" }), {
      target: { value: "desc" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Apply sort" }));
    expect(onSortChange).toHaveBeenCalledWith({
      column: "name",
      direction: "desc",
    });
  });
  it("applies multiple conditions and disables values for NULL checks", () => {
    const onApply = vi.fn();
    render(
      <TableFilters
        columns={["name", "status"]}
        applied={[]}
        busy={false}
        onApply={onApply}
        onClose={vi.fn()}
      />,
    );
    fireEvent.change(screen.getByLabelText("Filter value 1"), {
      target: { value: "Ada" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Add condition" }));
    fireEvent.change(screen.getByLabelText("Filter column 2"), {
      target: { value: "status" },
    });
    fireEvent.change(screen.getByLabelText("Filter operator 2"), {
      target: { value: "is_null" },
    });
    expect(
      (screen.getByLabelText("Filter value 2") as HTMLInputElement).disabled,
    ).toBe(true);
    fireEvent.click(screen.getByRole("button", { name: "Apply filters" }));
    expect(onApply).toHaveBeenCalledWith([
      { column: "name", operator: "contains", value: "Ada" },
      { column: "status", operator: "is_null", value: "" },
    ]);
  });
  it("clears applied filters without changing them on cancel", () => {
    const onApply = vi.fn();
    const onClose = vi.fn();
    render(
      <TableFilters
        columns={["name"]}
        applied={[{ column: "name", operator: "equals", value: "Ada" }]}
        busy={false}
        onApply={onApply}
        onClose={onClose}
      />,
    );
    fireEvent.change(screen.getByLabelText("Filter value 1"), {
      target: { value: "Other" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(onApply).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledOnce();
    fireEvent.click(screen.getByRole("button", { name: "Clear filters" }));
    expect(onApply).toHaveBeenCalledWith([]);
  });
});
