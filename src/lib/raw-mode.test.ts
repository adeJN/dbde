import { expect, it } from "vitest";
import { rawExpression } from "./raw-mode";
it("allows only supported, complete server function expressions", () => {
  expect(rawExpression(" now() ", "mysql")).toBe("NOW()");
  expect(rawExpression("CURRENT_TIMESTAMP", "sqlite")).toBe(
    "CURRENT_TIMESTAMP",
  );
  expect(rawExpression("gen_random_uuid()", "postgres")).toBe(
    "GEN_RANDOM_UUID()",
  );
  for (const v of [
    "now();delete from users",
    "sleep(30)",
    "'NOW()'",
    "NOW() --",
    "(select 1)",
  ])
    expect(() => rawExpression(v, "mysql")).toThrow();
  expect(() => rawExpression("NOW()", "sqlite")).toThrow();
});
