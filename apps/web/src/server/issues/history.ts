import type { Prisma } from "@getexception/db";
import { RETENTION_DAYS, RELEASE_ENVIRONMENTS } from "@getexception/protocol";

export function historyScope(
  environment = "all",
  now = new Date(),
): Prisma.IssueHistoryWhereInput {
  return {
    canonical: true,
    lastSeen: {
      gte: new Date(now.getTime() - RETENTION_DAYS.issueHistory * 86400_000),
    },
    ...(environment !== "all" ? { environment } : {}),
  };
}

export function firstReleaseScope(
  release: string,
  environment = "all",
  now = new Date(),
): Prisma.IssueHistoryWhereInput {
  return {
    ...historyScope(environment, now),
    firstSeenKnown: true,
    firstRelease: release,
  };
}

export function newInReleaseWhere(
  release: string,
  environment = "all",
  now = new Date(),
  eventScope: Prisma.ErrorEventWhereInput = {},
): Prisma.IssueWhereInput {
  return {
    OR: RELEASE_ENVIRONMENTS.filter(
      (value) => environment === "all" || value === environment,
    ).map((value) => ({
      histories: { some: firstReleaseScope(release, value, now) },
      events: { some: { ...eventScope, release, environment: value } },
    })),
  };
}

export function newInReleaseHistoryScope(
  release: string,
  environment = "all",
  now = new Date(),
): Prisma.IssueHistoryWhereInput {
  return {
    ...firstReleaseScope(release, environment, now),
    OR: RELEASE_ENVIRONMENTS.filter(
      (value) => environment === "all" || value === environment,
    ).map((value) => ({
      environment: value,
      issue: { events: { some: { release, environment: value } } },
    })),
  };
}
