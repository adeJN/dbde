// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
  within,
} from "@testing-library/react";
import TableContextMenu from "./TableContextMenu";
import MaintainResultDialog from "./MaintainResultDialog";

afterEach(cleanup);
const table = { name: "orders", schema: "shop", kind: "table" };
function menu(
  maintain: Partial<Parameters<typeof TableContextMenu>[0]["maintain"]> = {},
  kind = "table",
) {
  const trigger = document.createElement("button");
  document.body.append(trigger);
  const onMaintain = vi.fn();
  const onClose = vi.fn();
  render(
    <TableContextMenu
      table={{ ...table, kind }}
      target={{ x: 10, y: 10, trigger }}
      onAction={vi.fn()}
      onClose={onClose}
      maintain={{
        driver: "mysql",
        count: 1,
        repairable: false,
        onMaintain,
        ...maintain,
      }}
    />,
  );
  return { trigger, onMaintain, onClose };
}

it("opens the Maintain submenu with the keyboard and runs the chosen operation", () => {
  const { trigger, onMaintain, onClose } = menu({ count: 3 });
  const branch = screen.getByRole("menuitem", {
    name: /Maintain \(3 tables\)/,
  });
  expect(branch.getAttribute("aria-haspopup")).toBe("menu");
  branch.focus();
  fireEvent.keyDown(branch, { key: "ArrowRight" });
  const sub = screen.getByRole("menu", { name: "Maintain" });
  expect(branch.getAttribute("aria-expanded")).toBe("true");
  expect(document.activeElement).toBe(
    within(sub).getByRole("menuitem", { name: "Analyze" }),
  );
  // InnoDB cannot REPAIR; the item explains instead of failing later.
  const repair = within(sub).getByRole("menuitem", { name: "Repair…" });
  expect((repair as HTMLButtonElement).disabled).toBe(true);
  expect(repair.title).toContain("MyISAM");
  fireEvent.keyDown(document.activeElement!, { key: "ArrowDown" });
  expect(document.activeElement?.textContent).toContain("Check");
  fireEvent.keyDown(document.activeElement!, { key: "ArrowLeft" });
  expect(screen.queryByRole("menu", { name: "Maintain" })).toBeNull();
  expect(document.activeElement).toBe(branch);
  fireEvent.click(branch);
  fireEvent.click(
    within(screen.getByRole("menu", { name: "Maintain" })).getByRole(
      "menuitem",
      { name: "Optimize…" },
    ),
  );
  expect(onMaintain).toHaveBeenCalledWith("optimize");
  expect(onClose).toHaveBeenCalled();
  expect(document.activeElement).toBe(trigger);
  trigger.remove();
});

it("lists PostgreSQL and SQLite operations and blocks maintenance of a view", () => {
  menu({ driver: "postgres", repairable: true });
  fireEvent.click(screen.getByRole("menuitem", { name: /Maintain/ }));
  expect(
    within(screen.getByRole("menu", { name: "Maintain" }))
      .getAllByRole("menuitem")
      .map((item) => item.getAttribute("aria-label")),
  ).toEqual([
    "Analyze",
    "Vacuum",
    "Vacuum Analyze",
    "Vacuum Full…",
    "Reindex…",
  ]);
  cleanup();
  menu({ driver: "postgres", count: 0 }, "view");
  expect(
    (screen.getByRole("menuitem", { name: /Maintain/ }) as HTMLButtonElement)
      .disabled,
  ).toBe(true);
  cleanup();
  // SQLite VACUUM is database-wide, so it stays available from a view.
  menu({ driver: "sqlite", count: 0 }, "view");
  fireEvent.click(screen.getByRole("menuitem", { name: /Maintain/ }));
  const sub = screen.getByRole("menu", { name: "Maintain" });
  expect(
    (
      within(sub).getByRole("menuitem", {
        name: "Integrity Check",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(true);
  expect(
    (
      within(sub).getByRole("menuitem", {
        name: "Vacuum Database…",
      }) as HTMLButtonElement
    ).disabled,
  ).toBe(false);
});

it("shows maintenance messages, highlights problems, copies them and closes on Escape", async () => {
  const onCopy = vi.fn().mockResolvedValue(undefined);
  const onClose = vi.fn();
  render(
    <MaintainResultDialog
      label="Optimize"
      database="shop"
      result={{
        statements: ["OPTIMIZE TABLE `shop`.`orders`, `shop`.`gone`"],
        rows: [
          {
            table: "shop.orders",
            op: "optimize",
            msg_type: "note",
            msg_text:
              "Table does not support optimize, doing recreate + analyze instead",
          },
          {
            table: "shop.orders",
            op: "optimize",
            msg_type: "status",
            msg_text: "OK",
          },
          {
            table: "shop.gone",
            op: "optimize",
            msg_type: "Error",
            msg_text: "Table 'shop.gone' doesn't exist",
          },
        ],
        execution_ms: 41,
      }}
      onCopy={onCopy}
      onClose={onClose}
    />,
  );
  const dialog = screen.getByRole("dialog", { name: /Optimize results/ });
  expect(within(dialog).getByText(/shop · 2 tables/)).toBeTruthy();
  expect(within(dialog).getByRole("status").textContent).toBe(
    "1 message needs attention.",
  );
  expect(within(dialog).getByLabelText("Statements run").textContent).toBe(
    "OPTIMIZE TABLE `shop`.`orders`, `shop`.`gone`",
  );
  expect(
    within(dialog).getByText("Table 'shop.gone' doesn't exist").closest("tr")
      ?.className,
  ).toBe("maintain-error");
  expect(document.activeElement).toBe(
    within(dialog).getByLabelText("Maintenance messages"),
  );
  fireEvent.click(within(dialog).getByRole("button", { name: /Copy results/ }));
  await waitFor(() =>
    expect(onCopy).toHaveBeenCalledWith(
      expect.stringContaining("shop.gone\toptimize\tError"),
    ),
  );
  fireEvent.keyDown(dialog, { key: "Escape" });
  expect(onClose).toHaveBeenCalled();
});
