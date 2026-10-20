import { expect, it } from "vitest";
import {
  connectionColors,
  duplicateConnection,
  readConnectionAppearance,
  flushCommands,
} from "./connection-menu";
import { demoConfig } from "./api";
it("duplicates profile identity without copying its password", () => {
  const original = { ...demoConfig, password: "original-secret" };
  const duplicate = duplicateConnection(original);
  expect(duplicate.id).not.toBe(original.id);
  expect(duplicate.name).toBe(`${original.name} copy`);
  expect(duplicate.password).toBe("");
  expect(original.password).toBe("original-secret");
});
it("loads only valid appearance values and recovers from corrupt local data", () => {
  expect(readConnectionAppearance("broken")).toEqual({});
  expect(readConnectionAppearance("[]")).toEqual({});
  const data = readConnectionAppearance(
    JSON.stringify({
      one: { color: connectionColors[0], starred: true, group: " Local " },
      two: { color: "url(secret)", starred: "yes", group: "x".repeat(100) },
    }),
  );
  expect(data.one).toEqual({
    color: connectionColors[0],
    starred: true,
    group: "Local",
  });
  expect(data.two.color).toBeUndefined();
  expect(data.two.starred).toBe(false);
  expect(data.two.group).toHaveLength(60);
});
it("exposes a finite set of MySQL flush commands", () => {
  expect(Object.values(flushCommands)).toEqual([
    "FLUSH PRIVILEGES;",
    "FLUSH TABLES;",
    "FLUSH LOGS;",
    "FLUSH STATUS;",
  ]);
});
