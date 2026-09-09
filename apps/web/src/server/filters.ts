import { projectScope, type AccessMember } from "./access";
import type { Prisma } from "@getexception/db";
import { pageNumber, textParam, type Search } from "../lib/search-params";

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
    period: ["24h", "7d", "30d"].includes(textParam(search.period))
      ? textParam(search.period)
      : "all",
    sort: ["events", "first"].includes(textParam(search.sort))
      ? textParam(search.sort)
      : "recent",
    release: textParam(search.release),
    page: pageNumber(search.page),
  };
}

export function issueWhere(
  member: AccessMember,
  filters: ReturnType<typeof issueFilters>,
  now = Date.now(),
): Prisma.IssueWhereInput {
  return {
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
    ...(filters.period !== "all"
      ? {
          lastSeen: {
            gte: new Date(
              now -
                { "24h": 1, "7d": 7, "30d": 30 }[filters.period]! * 86400_000,
            ),
          },
        }
      : {}),
    ...(filters.environment !== "all" || filters.release
      ? {
          events: {
            some: {
              ...(filters.environment !== "all"
                ? { environment: filters.environment }
                : {}),
              ...(filters.release ? { release: filters.release } : {}),
            },
          },
        }
      : {}),
  };
}
