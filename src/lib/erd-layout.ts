import type { ModelTable } from "./database-model";
export const ERD_CARD_WIDTH = 290;
export const ERD_HEADER_HEIGHT = 38;
export const ERD_FIELD_HEIGHT = 24;
export const erdCardHeight = (table: ModelTable) =>
  ERD_HEADER_HEIGHT + table.columns.length * ERD_FIELD_HEIGHT + 12;
export function arrangeErd(tables: ModelTable[], columns = 3): ModelTable[] {
  const result: ModelTable[] = [];
  let y = 48;
  for (let start = 0; start < tables.length; start += columns) {
    const row = tables.slice(start, start + columns);
    row.forEach((table, i) =>
      result.push({ ...table, x: 48 + i * (ERD_CARD_WIDTH + 80), y }),
    );
    y += Math.max(...row.map(erdCardHeight)) + 80;
  }
  return result;
}
export function erdBounds(tables: ModelTable[]) {
  return {
    width: Math.max(960, ...tables.map((t) => t.x + ERD_CARD_WIDTH + 80)),
    height: Math.max(600, ...tables.map((t) => t.y + erdCardHeight(t) + 80)),
  };
}
export function erdRelationship(
  from: ModelTable,
  to: ModelTable,
  sourceField: string,
  targetField: string,
) {
  const sourceY =
    from.y +
    ERD_HEADER_HEIGHT +
    Math.max(
      0,
      from.columns.findIndex((c) => c.name === sourceField),
    ) *
      ERD_FIELD_HEIGHT +
    ERD_FIELD_HEIGHT / 2;
  const targetY =
    to.y +
    ERD_HEADER_HEIGHT +
    Math.max(
      0,
      to.columns.findIndex((c) => c.name === targetField),
    ) *
      ERD_FIELD_HEIGHT +
    ERD_FIELD_HEIGHT / 2;
  if (
    from.table.name === to.table.name &&
    from.table.schema === to.table.schema
  ) {
    const x = from.x + ERD_CARD_WIDTH;
    return {
      path: `M ${x} ${sourceY} C ${x + 70} ${sourceY}, ${x + 70} ${targetY}, ${x} ${targetY}`,
      x1: x,
      y1: sourceY,
      x2: x,
      y2: targetY,
      direction: 1,
    };
  }
  const right = to.x >= from.x + ERD_CARD_WIDTH / 2;
  const x1 = from.x + (right ? ERD_CARD_WIDTH : 0),
    x2 = to.x + (right ? 0 : ERD_CARD_WIDTH);
  const bend = Math.max(60, Math.abs(x2 - x1) / 2),
    direction = right ? 1 : -1;
  return {
    path: `M ${x1} ${sourceY} C ${x1 + bend * direction} ${sourceY}, ${x2 - bend * direction} ${targetY}, ${x2} ${targetY}`,
    x1,
    y1: sourceY,
    x2,
    y2: targetY,
    direction,
  };
}
export function erdFitZoom(
  viewport: { width: number; height: number },
  bounds: { width: number; height: number },
) {
  return Math.max(
    0.2,
    Math.min(
      1,
      (viewport.width - 24) / bounds.width,
      (viewport.height - 24) / bounds.height,
    ),
  );
}
