import { projectScope, type AccessMember } from "./access";
import type { Prisma } from "@getexception/db";
import { pageNumber, textParam, type Search } from "../lib/search-params";
import { tableSort } from "../lib/table-sort";
import { activityDateRange } from "../lib/activity";
import { newInReleaseWhere } from "./issues/history";

export function issueFilters(search: Search) {
  return {
    q: textParam(search.q),
    project: textParam(search.project, 64),
    status: ["open", "resolved", "regression"].includes(
      textParam(search.status),
    )
      ? textParam(search.status)
      : "all",
    environment: ["production", "staging", "development"].includes(
      textParam(search.environment),
    )
      ? textParam(search.environment)
      : "all",
    source: ["mapped", "unmapped"].includes(textParam(search.source))
      ? textParam(search.source)
      : "all",
    period: ["24h", "7d", "30d"].includes(textParam(search.period))
      ? textParam(search.period)
      : "all",
    ...tableSort(search, "issues"),
    release: textParam(search.release),
    novelty:
      textParam(search.release) && textParam(search.novelty) === "new"
        ? "new"
        : "all",
    page: pageNumber(search.page),
  };
}

export function issueWhere(
  member: AccessMember,
  filters: ReturnType<typeof issueFilters>,
  now = Date.now(),
): Prisma.IssueWhereInput {
  const range = activityDateRange(filters.period, new Date(now));
  const eventScope = {
    ...(filters.environment !== "all"
      ? { environment: filters.environment }
      : {}),
    ...(filters.release ? { release: filters.release } : {}),
    ...(range ? { receivedAt: range } : {}),
  };

  return {
    eventCount: { gt: 0 },
    project: {
      ...projectScope(member),
      ...(filters.project ? { id: filters.project } : {}),
    },
    ...(filters.q
      ? {
          OR: [
            { title: { contains: filters.q, mode: "insensitive" } },
            { exceptionType: { contains: filters.q, mode: "insensitive" } },
          ],
        }
      : {}),
    ...(filters.status === "regression"
      ? { regression: true, status: "open" }
      : filters.status !== "all"
        ? { status: filters.status }
        : {}),
    events: {
      some: {
        ...eventScope,
        ...(filters.source === "mapped"
          ? { symbolicationState: { in: ["complete", "partial"] } }
          : {}),
      },
      ...(filters.source === "unmapped"
        ? {
            none: {
              ...eventScope,
              symbolicationState: { in: ["complete", "partial"] },
            },
          }
        : {}),
    },
    ...(filters.novelty === "new"
      ? {
          AND: [
            newInReleaseWhere(
              filters.release,
              filters.environment,
              new Date(now),
              {
                ...eventScope,
                ...(filters.source === "mapped"
                  ? { symbolicationState: { in: ["complete", "partial"] } }
                  : {}),
              },
            ),
          ],
        }
      : {}),
  };
}
