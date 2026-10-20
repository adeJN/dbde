import { expect, it } from "vitest";
import { suggestTableName } from "./table-clipboard";
it("keeps free names, avoids collisions, and fits multi-byte identifiers", () => {
  expect(suggestTableName("customers", new Set(), "mysql")).toBe("customers");
  expect(
    suggestTableName(
      "customers",
      new Set(["customers", "customers_copy"]),
      "mysql",
    ),
  ).toBe("customers_copy2");
  const name = "界".repeat(21);
  const copied = suggestTableName(name, new Set([name]), "mysql");
  expect(new TextEncoder().encode(copied).length).toBeLessThanOrEqual(64);
  expect(copied.endsWith("_copy")).toBe(true);
});
