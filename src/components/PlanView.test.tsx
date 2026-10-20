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
import PlanView from "./PlanView";
import type { ExplainOutput, TabPlan } from "../types";
import pgAnalyze from "../lib/explain-samples/pg-update-analyze.json?raw";
import mariaJson from "../lib/explain-samples/mariadb-json.json?raw";
import sqlitePlan from "../lib/explain-samples/sqlite-eqp.json";

afterEach(cleanup);
const output = (patch: Partial<ExplainOutput>): ExplainOutput => ({
  format: "json",
  sql: "EXPLAIN …",
  raw: "",
  columns: [],
  rows: [],
  analyzed: false,
  rolled_back: false,
  server_version: "",
  execution_ms: 3,
  ...patch,
});
const plan = (driver: TabPlan["driver"], patch: Partial<ExplainOutput>) => ({
  driver,
  statement: "SELECT 1",
  output: output(patch),
});

it("shows the analyzed PostgreSQL tree with timings, the expensive node and full-scan warnings", () => {
  render(
    <PlanView
      plan={plan("postgres", {
        raw: pgAnalyze,
        analyzed: true,
        rolled_back: true,
        sql: "EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) UPDATE o SET total = total + 1",
      })}
      onCopy={vi.fn()}
    />,
  );
  expect(screen.getByText("Analyzed · rolled back")).toBeTruthy();
  expect(
    within(screen.getByRole("list", { name: "Plan warnings" })).getByText(
      "Full table scan on o",
    ),
  ).toBeTruthy();
  const tree = screen.getByRole("table", { name: "Plan tree" });
  for (const header of ["Actual rows", "Loops", "Time (ms)", "Share"])
    expect(
      within(tree).getByRole("columnheader", { name: header }),
    ).toBeTruthy();
  const scan = within(tree).getByRole("button", {
    name: /Seq Scan on o, expensive, warning: Full table scan on o/,
  });
  expect(scan.closest("tr")?.className).toContain("plan-expensive");
  expect(within(tree).getByText("ModifyTable (Update)")).toBeTruthy();
  fireEvent.click(scan);
  const details = screen.getByRole("complementary", { name: "Node details" });
  expect(within(details).getByText("(total > '4990'::numeric)")).toBeTruthy();
  expect(screen.getByText("Execution")).toBeTruthy();
});

it("keeps MariaDB duplicate tables, offers the raw document and copies it", async () => {
  const onCopy = vi.fn().mockResolvedValue(undefined);
  render(
    <PlanView
      plan={plan("mysql", {
        raw: mariaJson,
        columns: ["id", "table", "type"],
        rows: [
          [1, "c", "ALL"],
          [1, "o", "ref"],
        ],
      })}
      onCopy={onCopy}
    />,
  );
  const tree = screen.getByRole("table", { name: "Plan tree" });
  expect(
    within(tree).getByRole("button", { name: /Full table scan on c/ }),
  ).toBeTruthy();
  expect(
    within(tree).getByRole("button", { name: /Index lookup on o/ }),
  ).toBeTruthy();
  expect(
    within(tree).queryByRole("columnheader", { name: "Loops" }),
  ).toBeNull();
  fireEvent.click(screen.getByRole("tab", { name: "Grid" }));
  expect(
    within(screen.getByRole("table", { name: "Plan output" })).getByText("ref"),
  ).toBeTruthy();
  fireEvent.click(screen.getByRole("tab", { name: "Raw" }));
  expect(
    screen.getByRole("tab", { name: "Raw" }).getAttribute("aria-selected"),
  ).toBe("true");
  expect(screen.getByLabelText("Raw plan").textContent).toBe(mariaJson);
  fireEvent.click(screen.getByRole("button", { name: /Copy raw/ }));
  await waitFor(() => expect(onCopy).toHaveBeenCalledWith(mariaJson));
  expect(await screen.findByText("Raw plan copied.")).toBeTruthy();
});

it("renders SQLite's tabular plan as a nested tree without cost columns", () => {
  render(
    <PlanView
      plan={plan("sqlite", { format: "table", ...sqlitePlan })}
      onCopy={vi.fn()}
    />,
  );
  expect(screen.getByText("Estimated")).toBeTruthy();
  const tree = screen.getByRole("table", { name: "Plan tree" });
  expect(
    within(tree).queryByRole("columnheader", { name: "Share" }),
  ).toBeNull();
  expect(
    within(tree).getByRole("button", { name: /SCAN o on o, warning/ }),
  ).toBeTruthy();
  const search = within(tree).getByRole("button", {
    name: "SEARCH orders on orders",
  });
  expect(search.style.paddingLeft).toBe("22px");
  fireEvent.click(screen.getByRole("tab", { name: "Raw" }));
  expect(screen.getByLabelText("Raw plan").textContent).toContain(
    "id\tparent\tnotused\tdetail\n8\t0\t216\tSCAN o",
  );
});

it("falls back to the raw text when the plan cannot be parsed", () => {
  render(
    <PlanView plan={plan("postgres", { raw: "not json" })} onCopy={vi.fn()} />,
  );
  expect(screen.getByRole("alert").textContent).toContain(
    "Cannot read this plan",
  );
  expect(screen.getByLabelText("Raw plan").textContent).toBe("not json");
});
