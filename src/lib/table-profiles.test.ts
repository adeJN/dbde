// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import {
  checkedProfile,
  readTableProfiles,
  saveTableProfiles,
  type TableProfile,
} from "./table-profiles";
beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
    clear: () => values.clear(),
  });
});
afterEach(() => vi.unstubAllGlobals());
const profile: TableProfile = {
  id: "1",
  name: "Active",
  filters: [{ column: "status", operator: "equals", value: "active" }],
  sort: { column: "id", direction: "desc" },
  layout: { hidden: ["email"], frozen: ["id"] },
};
it("persists separate named table profiles and validates removed filter fields", () => {
  saveTableProfiles("table-a", [profile]);
  expect(readTableProfiles("table-a")).toEqual([profile]);
  expect(readTableProfiles("table-b")).toEqual([]);
  expect(checkedProfile(profile, ["id", "status"]).layout).toEqual({
    hidden: [],
    frozen: ["id"],
  });
  expect(() => checkedProfile(profile, ["id"])).toThrow("no longer exists");
});
it("rejects malformed storage and caps profile count", () => {
  localStorage.setItem("table-a:profiles", '[{"id":"bad"}]');
  expect(readTableProfiles("table-a")).toEqual([]);
  expect(() => saveTableProfiles("a", Array(31).fill(profile))).toThrow("30");
});
