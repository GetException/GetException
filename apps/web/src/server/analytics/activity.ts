import { Prisma, type Database } from "@getexception/db";
import { projectScopeSql, projectScope, type AccessMember } from "../access";
import {
  activityWindow,
  type ActivityFilters,
  type ActivityData,
} from "../../lib/activity";

type Window = ReturnType<typeof activityWindow>;

export type ActivityRow = {
  bucket: number;
  environment: string;
  handled: boolean;
  count: number;
  mapped: number;
  fatal: number;
};

export type BreakdownRow = {
  label: string | null;
  count: number;
  releaseId?: string | null;
  appVersion?: string | null;
};

export function activityWhere(
  member: AccessMember,
  filters: ActivityFilters,
  window: Window,
  issueId?: string,
): Prisma.ErrorEventWhereInput {
  return {
    project: {
      ...projectScope(member),
      ...(filters.project ? { id: filters.project } : {}),
    },
    receivedAt: { gte: window.start, lt: window.end },
    ...(filters.environment !== "all"
      ? { environment: filters.environment }
      : {}),
    ...(issueId ? { issueId } : {}),
  };
}

function activityScope(
  member: AccessMember,
  filters: ActivityFilters,
  window: Window,
  issueId?: string,
) {
  return Prisma.sql`${projectScopeSql(member)}
    ${filters.project ? Prisma.sql`AND p.id = ${filters.project}` : Prisma.empty}
    AND e."receivedAt" >= ${window.start} AND e."receivedAt" < ${window.end}
    ${filters.environment !== "all" ? Prisma.sql`AND e.environment = ${filters.environment}` : Prisma.empty}
    ${issueId ? Prisma.sql`AND e."issueId" = ${issueId}` : Prisma.empty}`;
}

export function activityData(
  rows: ActivityRow[],
  window: Window,
): ActivityData {
  const result: ActivityData = {
    buckets: Array.from({ length: window.buckets }, (_, i) => ({
      start: new Date(
        window.start.getTime() + i * window.bucketMs,
      ).toISOString(),
      end: new Date(
        window.start.getTime() + (i + 1) * window.bucketMs,
      ).toISOString(),
      count: 0,
      production: 0,
      staging: 0,
      development: 0,
      handled: 0,
      unhandled: 0,
    })),
    total: 0,
    unhandled: 0,
    mapped: 0,
    fatal: 0,
  };

  for (const row of rows) {
    const bucket = result.buckets[row.bucket];

    if (!bucket) {
      continue;
    }

    if (
      row.environment === "production" ||
      row.environment === "staging" ||
      row.environment === "development"
    ) {
      bucket[row.environment] += row.count;
    }

    bucket[row.handled ? "handled" : "unhandled"] += row.count;
    bucket.count += row.count;
    result.total += row.count;
    result.unhandled += row.handled ? 0 : row.count;
    result.mapped += row.mapped;
    result.fatal += row.fatal;
  }

  return result;
}

export async function eventActivity(
  db: Database,
  member: AccessMember,
  filters: ActivityFilters,
  window: Window,
  issueId?: string,
) {
  const rows = await db.$queryRaw<ActivityRow[]>(Prisma.sql`
    SELECT floor(extract(epoch FROM (e."receivedAt" - ${window.start}::timestamptz)) * 1000 / ${window.bucketMs})::integer AS bucket,
      e.environment, e.handled, count(*)::integer AS count,
      count(*) FILTER (WHERE e."symbolicationState" IN ('complete', 'partial'))::integer AS mapped,
      count(*) FILTER (WHERE e.level = 'fatal')::integer AS fatal
    FROM error_event e JOIN project p ON p.id = e."projectId"
    WHERE ${activityScope(member, filters, window, issueId)}
    GROUP BY 1, 2, 3 ORDER BY 1
  `);

  return activityData(rows, window);
}

export async function eventBreakdowns(
  db: Database,
  member: AccessMember,
  filters: ActivityFilters,
  window: Window,
  issueId?: string,
) {
  const scope = activityScope(member, filters, window, issueId);
  const [browsers, releases] = await Promise.all([
    db.$queryRaw<BreakdownRow[]>(Prisma.sql`
      SELECT CASE WHEN e."browserName" IS NULL THEN NULL ELSE e."browserName" || coalesce(' ' || e."browserMajor"::text, '') END AS label,
        count(*)::integer AS count
      FROM error_event e JOIN project p ON p.id = e."projectId" WHERE ${scope}
      GROUP BY 1 ORDER BY count DESC, label ASC NULLS LAST LIMIT 5
    `),
    db.$queryRaw<BreakdownRow[]>(Prisma.sql`
      SELECT e.release AS label, r.id AS "releaseId", r."appVersion" AS "appVersion", count(*)::integer AS count
      FROM error_event e JOIN project p ON p.id = e."projectId"
      LEFT JOIN release r ON r."projectId" = e."projectId" AND r.name = e.release
      WHERE ${scope} GROUP BY e."projectId", e.release, r.id
      ORDER BY count DESC, label ASC NULLS LAST, r.id ASC LIMIT 5
    `),
  ]);

  return { browsers, releases };
}
