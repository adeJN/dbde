import type { Driver } from "../types";
export function rawExpression(value: string, driver: Driver): string {
  const expression = value.trim().toUpperCase();
  const common = ["CURRENT_TIMESTAMP", "CURRENT_DATE", "CURRENT_TIME"];
  const allowed =
    driver === "mysql"
      ? [...common, "NOW()", "UUID()"]
      : driver === "postgres"
        ? [...common, "NOW()", "GEN_RANDOM_UUID()", "RANDOM()"]
        : [...common, "RANDOM()"];
  if (!allowed.includes(expression))
    throw new Error(
      `Raw Mode accepts ${allowed.join(", ")}. Turn Raw Mode off to enter a literal value.`,
    );
  return expression;
}
