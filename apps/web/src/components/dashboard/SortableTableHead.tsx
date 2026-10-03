import Link from "next/link";
import type { ReactNode } from "react";
import { linkTo } from "../../lib/search-params";
import {
  sortParams,
  tableColumns,
  type SortColumn,
  type TableName,
  type TableSort,
} from "../../lib/table-sort";

export function SortableTableHead({
  table,
  sorting,
  path,
  values,
  prefix = "",
  children,
}: {
  table: TableName;
  sorting: TableSort;
  path: string;
  values: Record<string, string | number | undefined>;
  prefix?: string;
  children?: ReactNode;
}) {
  const keys = sortParams(prefix);
  const columns: SortColumn[] = tableColumns[table];

  return (
    <thead>
      <tr>
        {columns.map((column) => {
          const active = sorting.sort === column.key;
          const direction = active
            ? sorting.direction === "asc"
              ? "desc"
              : "asc"
            : (column.direction ?? "asc");

          return (
            <th
              key={column.key}
              scope="col"
              className={column.numeric ? "numeric" : undefined}
              aria-sort={
                active
                  ? sorting.direction === "asc"
                    ? "ascending"
                    : "descending"
                  : undefined
              }
              title={column.title}
            >
              <Link
                className="table-sort"
                scroll={false}
                prefetch={false}
                href={linkTo(path, {
                  ...values,
                  [keys.sort]: column.key,
                  [keys.direction]: direction,
                  [keys.page]: 1,
                })}
                aria-label={`${column.label}: sort ${direction === "asc" ? "ascending" : "descending"}`}
              >
                {column.label}
                <span className="table-sort-arrow" aria-hidden="true">
                  {active ? (sorting.direction === "asc" ? "↑" : "↓") : "↕"}
                </span>
              </Link>
            </th>
          );
        })}
        {children}
      </tr>
    </thead>
  );
}
