import type { Prisma } from "@getexception/db";
import type { TableSort } from "../../lib/table-sort";

export function issueOrder({
  sort,
  direction,
}: TableSort): Prisma.IssueOrderByWithRelationInput[] {
  const columns: Record<string, Prisma.IssueOrderByWithRelationInput[]> = {
    issue: [{ exceptionType: direction }, { title: direction }],
    project: [{ project: { name: direction } }],
    status: [{ status: direction }, { regression: direction }],
    events: [{ eventCount: direction }],
    first: [{ firstSeen: direction }],
    recent: [{ lastSeen: direction }],
  };

  return [
    ...(Object.hasOwn(columns, sort) ? columns[sort]! : columns.recent!),
    { id: direction },
  ];
}

export function eventOrder({
  sort,
  direction,
}: TableSort): Prisma.ErrorEventOrderByWithRelationInput[] {
  const columns: Record<string, Prisma.ErrorEventOrderByWithRelationInput> = {
    time: { receivedAt: direction },
    event: { eventId: direction },
    release: { release: { sort: direction, nulls: "last" } },
    environment: { environment: direction },
    level: { level: direction },
    handling: { handled: direction === "asc" ? "desc" : "asc" },
  };

  return [
    Object.hasOwn(columns, sort) ? columns[sort]! : columns.time!,
    { id: direction },
  ];
}
