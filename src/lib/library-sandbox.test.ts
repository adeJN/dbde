// @vitest-environment jsdom
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  appendHistory,
  clearHistory,
  deleteHistory,
  deleteLibraryItems,
  listHistory,
  listLibrary,
  onLibraryChange,
  saveLibraryItems,
} from "./api";
import { historyEntry } from "./query-history";

beforeEach(() => {
  const storage = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => storage.get(key) ?? null,
    setItem: (key: string, value: string) => storage.set(key, value),
    removeItem: (key: string) => storage.delete(key),
  });
});
const entry = (id: string) =>
  historyEntry({
    id,
    at: 1,
    profileId: "demo",
    connectionName: "Demo",
    sql: "SELECT 1",
    durationMs: 1,
  });

describe("browser sandbox query library", () => {
  it("keeps history in localStorage with delete and clear", async () => {
    await appendHistory(entry("a"));
    await appendHistory(entry("b"));
    expect((await listHistory()).map((e) => (e as { id: string }).id)).toEqual([
      "a",
      "b",
    ]);
    await deleteHistory(["a"]);
    expect(await listHistory()).toHaveLength(1);
    await clearHistory();
    expect(await listHistory()).toEqual([]);
  });

  it("upserts and deletes library items by id", async () => {
    await saveLibraryItems("snippets", [{ id: "a" }, { id: "b" }]);
    await saveLibraryItems("snippets", [{ id: "a", v: 2 } as { id: string }]);
    expect(await listLibrary("snippets")).toEqual([
      { id: "a", v: 2 },
      { id: "b" },
    ]);
    expect(await listLibrary("saved_queries")).toEqual([]);
    await deleteLibraryItems("snippets", ["b"]);
    expect(await listLibrary("snippets")).toEqual([{ id: "a", v: 2 }]);
  });

  it("reports changes made by other tabs through storage events", async () => {
    const listener = vi.fn();
    const stop = await onLibraryChange(listener);
    window.dispatchEvent(
      new StorageEvent("storage", { key: "dbde.sandbox.saved_queries" }),
    );
    window.dispatchEvent(new StorageEvent("storage", { key: "other" }));
    expect(listener).toHaveBeenCalledTimes(1);
    expect(listener).toHaveBeenCalledWith({
      kind: "saved_queries",
      op: "reload",
    });
    stop();
    window.dispatchEvent(
      new StorageEvent("storage", { key: "dbde.sandbox.history" }),
    );
    expect(listener).toHaveBeenCalledTimes(1);
  });
});
