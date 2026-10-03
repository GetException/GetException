import { Prisma, type Database } from "@getexception/db";
import { activityDateRange } from "../../lib/activity";

export type LatestIssueEvent = {
  issueId: string;
  eventId: string;
  environment: string;
  release: string | null;
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
  },
  now = new Date(),
): Promise<LatestIssueEvent[]> {
  if (!issueIds.length) {
    return [];
  }

  const range = activityDateRange(filters.period ?? "all", now);

  return db.$queryRaw<LatestIssueEvent[]>(Prisma.sql`
    SELECT DISTINCT ON ("issueId") "issueId", "eventId", environment, release, "receivedAt", "symbolicationState"
    FROM error_event
    WHERE "issueId" IN (${Prisma.join(issueIds)})
      ${filters.environment === "all" ? Prisma.empty : Prisma.sql`AND environment = ${filters.environment}`}
      ${filters.release ? Prisma.sql`AND release = ${filters.release}` : Prisma.empty}
      ${filters.source === "mapped" ? Prisma.sql`AND "symbolicationState" IN ('complete', 'partial')` : Prisma.empty}
      ${range ? Prisma.sql`AND "receivedAt" >= ${range.gte} AND "receivedAt" < ${range.lt}` : Prisma.empty}
    ORDER BY "issueId", "receivedAt" DESC, id DESC
  `);
}
