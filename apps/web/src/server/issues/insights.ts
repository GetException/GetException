import { Prisma, type Database } from "@getexception/db";

export type LatestIssueEvent = {
  issueId: string;
  eventId: string;
  environment: string;
  release: string | null;
  receivedAt: Date;
};

export async function latestIssueEvents(
  db: Database,
  issueIds: string[],
  filters: { environment: string; release: string },
): Promise<LatestIssueEvent[]> {
  if (!issueIds.length) {
    return [];
  }

  return db.$queryRaw<LatestIssueEvent[]>(Prisma.sql`
    SELECT DISTINCT ON ("issueId") "issueId", "eventId", environment, release, "receivedAt"
    FROM error_event
    WHERE "issueId" IN (${Prisma.join(issueIds)})
      ${filters.environment === "all" ? Prisma.empty : Prisma.sql`AND environment = ${filters.environment}`}
      ${filters.release ? Prisma.sql`AND release = ${filters.release}` : Prisma.empty}
    ORDER BY "issueId", "receivedAt" DESC, id DESC
  `);
}

export type TrendDay = { date: string; count: number };

export async function issueTrend(
  db: Database,
  projectId: string,
  issueId: string,
  now = new Date(),
): Promise<TrendDay[]> {
  const today = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
  );
  const firstDay = new Date(today - 6 * 86_400_000);
  const rows = await db.$queryRaw<{ date: string; count: number }[]>`
    SELECT to_char("receivedAt" AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS date,
           COUNT(*)::integer AS count
    FROM error_event
    WHERE "projectId" = ${projectId}
      AND "issueId" = ${issueId}
      AND "receivedAt" >= ${firstDay}
    GROUP BY 1
    ORDER BY 1
  `;
  const counts = new Map(rows.map((row) => [row.date, row.count]));

  return Array.from({ length: 7 }, (_, index) => {
    const date = new Date(firstDay.getTime() + index * 86_400_000)
      .toISOString()
      .slice(0, 10);

    return { date, count: counts.get(date) ?? 0 };
  });
}
