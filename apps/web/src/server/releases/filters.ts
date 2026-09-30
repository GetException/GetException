import type { Prisma } from "@getexception/db";
import { projectScope, type AccessMember } from "../access";
import { pageNumber, textParam, type Search } from "../../lib/search-params";
import {
  reviewLabel,
  ENVIRONMENT_LABELS,
} from "../../components/releases/presentation";

export function releaseFilters(search: Search) {
  const environment = textParam(search.environment);
  const review = textParam(search.review, 40);

  return {
    project: textParam(search.project, 64),
    q: textParam(search.q),
    environment: Object.hasOwn(ENVIRONMENT_LABELS, environment)
      ? environment
      : "all",
    review: reviewLabel(review) ? review : "",
    maps: [
      "ready",
      "unavailable",
      "removed",
      "missing",
      "failed",
      "pending",
    ].includes(textParam(search.maps))
      ? textParam(search.maps)
      : "all",
    page: pageNumber(search.page),
  };
}

export function releaseWhere(
  member: AccessMember,
  filters: ReturnType<typeof releaseFilters>,
): Prisma.ReleaseWhereInput {
  return {
    project: {
      ...projectScope(member),
      ...(filters.project ? { id: filters.project } : {}),
    },
    ...(filters.q
      ? { name: { contains: filters.q, mode: "insensitive" as const } }
      : {}),
    ...(filters.maps === "unavailable"
      ? { sourceMapsState: { in: ["missing", "removed", "failed"] } }
      : filters.maps === "removed"
        ? {
            OR: [
              { sourceMapsState: "removed" },
              { sourceMapsState: "missing", sourceMapsVersion: { gt: 0 } },
            ],
          }
        : filters.maps === "missing"
          ? { sourceMapsState: "missing", sourceMapsVersion: 0 }
          : filters.maps !== "all"
            ? { sourceMapsState: filters.maps }
            : {}),
    ...(filters.environment !== "all" || filters.review
      ? {
          deployments: {
            some: {
              ...(filters.environment !== "all"
                ? { environment: filters.environment }
                : {}),
              ...(filters.review ? { reviewKey: filters.review } : {}),
            },
          },
        }
      : {}),
  };
}
