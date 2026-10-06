import { Prisma, type Database } from "@getexception/db";
import { activityDateRange } from "../../lib/activity";
import { RETENTION_DAYS } from "@getexception/protocol";

export type LatestIssueEvent = {
  issueId: string;
  eventId: string;
  environment: string;
  release: string | null;
  appVersion: string | null;
  receivedAt: Date;
  symbolicationState: string;
};

export async function latestIssueEvents(
  db: Database,
  issueIds: string[],
  filters: {
    environment: string;
    release: string;
    source?: string;
    period?: string;
    novelty?: string;
  },
  now = new Date(),
): Promise<LatestIssueEvent[]> {
  if (!issueIds.length) {
    return [];
  }

  const range = activityDateRange(filters.period ?? "all", now);

  return db.$queryRaw<LatestIssueEvent[]>(Prisma.sql`
    SELECT DISTINCT ON ("issueId") "issueId", "eventId", environment, release, "appVersion", "receivedAt", "symbolicationState"
    FROM error_event e
    WHERE "issueId" IN (${Prisma.join(issueIds)})
      ${filters.environment === "all" ? Prisma.empty : Prisma.sql`AND environment = ${filters.environment}`}
      ${filters.release ? Prisma.sql`AND release = ${filters.release}` : Prisma.empty}
      ${filters.novelty === "new" && filters.release ? Prisma.sql`AND EXISTS (SELECT 1 FROM issue_history h WHERE h."issueId" = e."issueId" AND h.canonical AND h."firstSeenKnown" AND h.environment = e.environment AND h."firstRelease" = e.release AND h."lastSeen" >= ${new Date(now.getTime() - RETENTION_DAYS.issueHistory * 86400_000)})` : Prisma.empty}
      ${filters.source === "mapped" ? Prisma.sql`AND "symbolicationState" IN ('complete', 'partial')` : Prisma.empty}
      ${range ? Prisma.sql`AND "receivedAt" >= ${range.gte} AND "receivedAt" < ${range.lt}` : Prisma.empty}
    ORDER BY "issueId", "receivedAt" DESC, id DESC
  `);
}
