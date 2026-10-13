// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import Pagination from "./Pagination";
afterEach(cleanup);
describe("pagination controls", () => {
  it("accepts custom whole numbers, rejects non-digits and validates bounds", () => {
    const onChange = vi.fn();
    render(
      <Pagination
        page={2}
        pageSize={1000}
        totalRows={3500}
        rowCount={1000}
        busy={false}
        onChange={onChange}
      />,
    );
    const input = screen.getByRole("textbox", {
      name: "Rows per page",
    }) as HTMLInputElement;
    for (const value of ["abc", "1.5", "-20", "1e3", "12a"]) {
      fireEvent.change(input, { target: { value } });
      expect(input.value).toBe("1000");
    }
    for (const value of ["", "0", "5001"]) {
      fireEvent.change(input, { target: { value } });
      fireEvent.keyDown(input, { key: "Enter" });
      expect(screen.getByRole("alert").textContent).toContain("1 to 5,000");
      expect(onChange).not.toHaveBeenCalled();
    }
    fireEvent.change(input, { target: { value: "375" } });
    expect(onChange).not.toHaveBeenCalled();
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.blur(input);
    expect(onChange).toHaveBeenCalledTimes(1);
    expect(onChange).toHaveBeenCalledWith(1, 375);
    fireEvent.change(input, { target: { value: "42" } });
    fireEvent.keyDown(input, { key: "Escape" });
    expect(input.value).toBe("1000");
  });
  it("shows range and requests the next page or a new size starting at page one", () => {
    const onChange = vi.fn();
    render(
      <Pagination
        page={2}
        pageSize={1000}
        totalRows={3500}
        rowCount={1000}
        busy={false}
        onChange={onChange}
      />,
    );
    expect(screen.getByText("Page 2 of 4")).toBeTruthy();
    expect(
      screen.getByRole("navigation", { name: "Table pagination" }).textContent,
    ).toContain("1,001–2,000");
    fireEvent.click(screen.getByRole("button", { name: "Next page" }));
    expect(onChange).toHaveBeenLastCalledWith(3, 1000);
    fireEvent.change(screen.getByRole("textbox", { name: "Rows per page" }), {
      target: { value: "500" },
    });
    fireEvent.keyDown(screen.getByRole("textbox", { name: "Rows per page" }), {
      key: "Enter",
    });
    expect(onChange).toHaveBeenLastCalledWith(1, 500);
    fireEvent.click(screen.getByRole("button", { name: "Last page" }));
    expect(onChange).toHaveBeenLastCalledWith(4, 1000);
  });
  it("disables navigation at bounds and while loading", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <Pagination
        page={1}
        pageSize={1000}
        totalRows={0}
        rowCount={0}
        busy={false}
        onChange={onChange}
      />,
    );
    for (const button of screen.getAllByRole("button"))
      expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(screen.getByText("Page 1 of 1")).toBeTruthy();
    rerender(
      <Pagination
        page={2}
        pageSize={1000}
        totalRows={3500}
        rowCount={1000}
        busy
        onChange={onChange}
      />,
    );
    for (const button of screen.getAllByRole("button"))
      expect((button as HTMLButtonElement).disabled).toBe(true);
    expect(
      (
        screen.getByRole("textbox", {
          name: "Rows per page",
        }) as HTMLInputElement
      ).disabled,
    ).toBe(true);
  });
});
