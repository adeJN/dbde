import { expect, it } from "vitest";
import {
  fieldChangesError,
  initialFieldType,
  initialDefault,
} from "./field-changes";
const columns = [{ name: "price", data_type: "decimal(10,2)", nullable: true }];
it("validates precision, null defaults and literal default values before writing", () => {
  const type = initialFieldType(columns[0]);
  expect(
    fieldChangesError(
      columns,
      [],
      [
        {
          from: "price",
          to: "price",
          patch: { data_type: { ...type, length: "2", decimals: "3" } },
        },
      ],
    ),
  ).toContain("decimals");
  expect(
    fieldChangesError(
      columns,
      [],
      [
        {
          from: "price",
          to: "price",
          patch: { not_null: true, default: { kind: "null", value: "" } },
        },
      ],
    ),
  ).toContain("cannot default to NULL");
  expect(
    fieldChangesError(
      columns,
      [],
      [
        {
          from: "price",
          to: "price",
          patch: { default: { kind: "value", value: "abc" } },
        },
      ],
    ),
  ).toBeTruthy();
  expect(
    fieldChangesError(
      columns,
      [],
      [
        {
          from: "price",
          to: "price",
          patch: {
            data_type: { ...type, length: "12", decimals: "3" },
            default: { kind: "value", value: "1.250" },
          },
        },
      ],
    ),
  ).toBe("");
});
it("preserves enum values and numeric attributes while normalizing display types", () => {
  expect(
    initialFieldType({
      name: "id",
      data_type: "int(11) unsigned zerofill",
      nullable: false,
    }),
  ).toMatchObject({
    name: "int",
    length: "11",
    unsigned: true,
    zerofill: true,
  });
  expect(
    initialFieldType({
      name: "state",
      data_type: "enum('new','it''s ready')",
      nullable: true,
    }).values,
  ).toEqual(["new", "it's ready"]);
  expect(initialDefault({ default_value: "'Guest'" } as never)).toEqual({
    kind: "value",
    value: "Guest",
  });
});
