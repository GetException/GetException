import { Prisma } from "@getexception/db";
import type { TableSort } from "../lib/table-sort";
import { MAX_PAGE, PAGE_SIZE } from "../lib/pagination";

// Only code-defined expressions enter ORDER BY; URL values are never SQL identifiers.
export function sqlOrder(
  columns: Record<string, Prisma.Sql>,
  sorting: TableSort,
  fallback: string,
  id: Prisma.Sql,
) {
  const column = Object.hasOwn(columns, sorting.sort)
    ? columns[sorting.sort]!
    : columns[fallback]!;
  const direction =
    sorting.direction === "asc" ? Prisma.sql`ASC` : Prisma.sql`DESC`;

  return Prisma.sql`${column} ${direction} NULLS LAST, ${id} ${direction}`;
}

export function sqlPage(page: number, size = PAGE_SIZE) {
  const bounded = Number.isSafeInteger(page)
    ? Math.max(1, Math.min(MAX_PAGE, page))
    : 1;

  return Prisma.sql`LIMIT ${size} OFFSET ${(bounded - 1) * size}`;
}

export function inPageOrder<T extends { id: string }>(
  rows: T[],
  ids: { id: string }[],
): T[] {
  const byId = new Map(rows.map((row) => [row.id, row]));

  return ids.flatMap(({ id }) => {
    const row = byId.get(id);

    return row ? [row] : [];
  });
}
