import { expect, it } from "vitest";
import { fieldRenameError } from "./field-renames";
it("validates names by dialect and keeps quoted identifiers available", () => {
  expect(
    fieldRenameError(["id", "name"], [{ from: "name", to: "ID" }], "mysql"),
  ).toContain("already exists");
  expect(
    fieldRenameError(["id", "name"], [{ from: "name", to: "ID" }], "postgres"),
  ).toBe("");
  expect(
    fieldRenameError(["name"], [{ from: "name", to: "  " }], "mysql"),
  ).toContain("empty");
  expect(
    fieldRenameError(["name"], [{ from: "name", to: "x\0y" }], "sqlite"),
  ).toContain("NUL");
  expect(
    fieldRenameError(
      ["name"],
      [{ from: "name", to: "🙂".repeat(20) }],
      "postgres",
    ),
  ).toContain("63 bytes");
  expect(
    fieldRenameError(
      ["name"],
      [{ from: "name", to: "full `name`; SELECT 1" }],
      "mysql",
    ),
  ).toBe("");
  expect(
    fieldRenameError(
      ["name", "note"],
      [
        { from: "name", to: "title" },
        { from: "note", to: "title" },
      ],
      "sqlite",
    ),
  ).toContain("already exists");
});
