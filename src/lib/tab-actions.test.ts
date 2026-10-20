import { expect, it } from "vitest";
import { tabsToClose, readTabFavorites, favoriteFor } from "./tab-actions";
import { useWorkspace } from "../store";
import type { QueryTab, Session } from "../types";
const tabs: QueryTab[] = ["one", "two", "three"].map((id) => ({
  id,
  name: id,
  connectionId: "local",
  database: "shop",
  query: "SELECT 1",
  running: false,
}));
it("selects the close targets using the current tab order", () => {
  expect(tabsToClose(tabs, "two", "right").map((tab) => tab.id)).toEqual([
    "three",
  ]);
  expect(tabsToClose(tabs, "two", "others").map((tab) => tab.id)).toEqual([
    "one",
    "three",
  ]);
  expect(tabsToClose(tabs, "missing", "all")).toEqual([]);
});
it("reorders tabs and chooses the nearest surviving tab when closing", () => {
  useWorkspace.setState({ tabs, activeTab: "two" });
  useWorkspace.getState().closeTabs(["two"]);
  expect(useWorkspace.getState().activeTab).toBe("one");
  useWorkspace.getState().reorderTab("three", "one");
  expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toEqual([
    "three",
    "one",
  ]);
  useWorkspace.getState().reorderTab("three", "one", true);
  expect(useWorkspace.getState().tabs.map((tab) => tab.id)).toEqual([
    "one",
    "three",
  ]);
});
it("stores only reopenable favorite data and rejects malformed stored entries", () => {
  const session = {
    config: { id: "profile", database: "shop", password: "secret" },
  } as Session;
  const favorite = favoriteFor(tabs[0], session);
  expect(JSON.stringify(favorite)).not.toContain("secret");
  expect(
    readTabFavorites(JSON.stringify([favorite, { kind: "table", id: "bad" }])),
  ).toEqual([favorite]);
});
