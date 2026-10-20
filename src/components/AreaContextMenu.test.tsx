// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import AreaContextMenu from "./AreaContextMenu";
afterEach(cleanup);
it("keeps the menu on screen, skips disabled actions, invokes actions and restores focus", () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  const action = vi.fn(),
    onClose = vi.fn();
  render(
    <AreaContextMenu
      menu={{
        x: 9999,
        y: 9999,
        trigger,
        label: "Table list actions",
        items: [
          { label: "Unavailable", disabled: true, action },
          { label: "New Table", action },
          { label: "Refresh", action },
        ],
      }}
      onClose={onClose}
    />,
  );
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "New Table" }),
  );
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement).toBe(
    screen.getByRole("menuitem", { name: "Refresh" }),
  );
  fireEvent.click(document.activeElement!);
  expect(action).toHaveBeenCalledOnce();
  expect(onClose).toHaveBeenCalledOnce();
  expect(document.activeElement).toBe(trigger);
  expect(fireEvent.contextMenu(screen.getByRole("menu"))).toBe(false);
  trigger.remove();
});
