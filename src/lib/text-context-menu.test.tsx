// @vitest-environment jsdom
import { useState } from "react";
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, render, screen, waitFor } from "@testing-library/react";
import { textContextItems } from "./text-context-menu";
afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});
it("pastes into a controlled input through its existing change handler", async () => {
  function Field() {
    const [value, setValue] = useState("alpha beta");
    return (
      <input
        aria-label="Field"
        value={value}
        onChange={(event) => setValue(event.target.value)}
      />
    );
  }
  render(<Field />);
  const input = screen.getByLabelText("Field") as HTMLInputElement;
  input.setSelectionRange(6, 10);
  Object.defineProperty(navigator, "clipboard", {
    configurable: true,
    value: { readText: vi.fn().mockResolvedValue("gamma") },
  });
  const onError = vi.fn();
  textContextItems(input, onError)
    .find((item) => item.label === "Paste")!
    .action();
  await waitFor(() => expect(input.value).toBe("alpha gamma"));
  expect(onError).not.toHaveBeenCalled();
});
it("disables cut and copy for password fields", () => {
  const input = document.createElement("input");
  input.type = "password";
  input.value = "secret";
  input.setSelectionRange(0, 6);
  const items = textContextItems(input, vi.fn());
  expect(items.find((item) => item.label === "Copy")!.disabled).toBe(true);
  expect(items.find((item) => item.label === "Cut")!.disabled).toBe(true);
});
