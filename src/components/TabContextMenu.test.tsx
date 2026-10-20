// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import TabContextMenu from "./TabContextMenu";
afterEach(cleanup);
it("matches the reference and skips disabled actions with keyboard navigation", () => {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  const close = vi.fn();
  const action = vi.fn();
  render(
    <TabContextMenu
      target={{ id: "one", x: 20, y: 20, trigger }}
      name="Orders"
      disabled={{ right: true }}
      favorite={false}
      onClose={close}
      onAction={action}
    />,
  );
  expect(
    screen.getAllByRole("menuitem").map((item) => item.textContent),
  ).toEqual([
    "Close",
    "Close Other Tabs",
    "Close Tabs to the Right",
    "Close All",
    "Move Tab to New Window",
    "Add to Favorites",
    "Reveal in Navigation Pane",
  ]);
  const menu = screen.getByRole("menu");
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  fireEvent.keyDown(menu, { key: "ArrowDown" });
  expect(document.activeElement?.textContent).toBe("Close All");
  fireEvent.click(screen.getByRole("menuitem", { name: "Add to Favorites" }));
  expect(action).toHaveBeenCalledWith("favorite");
  fireEvent.keyDown(menu, { key: "Escape" });
  expect(close).toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});
