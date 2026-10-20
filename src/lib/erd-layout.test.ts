import { expect, it } from "vitest";
import {
  arrangeErd,
  erdBounds,
  erdCardHeight,
  erdFitZoom,
  erdRelationship,
  ERD_CARD_WIDTH,
} from "./erd-layout";
import type { ModelTable } from "./database-model";
const table = (name: string, fields: number): ModelTable => ({
  table: { name, schema: "public", kind: "table" },
  columns: Array.from({ length: fields }, (_, i) => ({
    name: `field_${i}`,
    data_type: "integer",
    nullable: true,
  })),
  indexes: [],
  keys: [],
  x: 48,
  y: 48,
});
it("sizes cards for every field and arranges tall rows without overlap", () => {
  const tables = arrangeErd([
    table("a", 20),
    table("b", 2),
    table("c", 5),
    table("d", 4),
  ]);
  expect(erdCardHeight(tables[0])).toBe(530);
  expect(tables[3].y).toBeGreaterThan(tables[0].y + erdCardHeight(tables[0]));
  expect(tables[1].x).toBeGreaterThan(tables[0].x + ERD_CARD_WIDTH);
  expect(erdBounds(tables).height).toBeGreaterThan(
    tables[3].y + erdCardHeight(tables[3]),
  );
});
it("connects field rows and routes self references as curves outside the card", () => {
  const from = table("a", 5),
    to = { ...table("b", 4), x: 600, y: 100 };
  const edge = erdRelationship(from, to, "field_3", "field_1");
  expect(edge.y1).toBe(48 + 38 + 3 * 24 + 12);
  expect(edge.y2).toBe(100 + 38 + 24 + 12);
  expect(edge.x1).toBe(48 + ERD_CARD_WIDTH);
  expect(edge.path).toContain("C");
  expect(erdRelationship(from, from, "field_1", "field_0").path).toContain("C");
});
it("keeps fit zoom bounded for large and tiny viewports", () => {
  expect(
    erdFitZoom({ width: 1000, height: 800 }, { width: 500, height: 500 }),
  ).toBe(1);
  expect(
    erdFitZoom({ width: 0, height: 0 }, { width: 5000, height: 5000 }),
  ).toBe(0.2);
});
