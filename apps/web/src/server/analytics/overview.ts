import { Prisma, type Database } from "@getexception/db";
import { projectScope, projectScopeSql, type AccessMember } from "../access";
import { activityWindow, type ActivityFilters } from "../../lib/activity";
import { activityWhere } from "./activity";

export type ProjectHealth = {
  id: string;
  name: string;
  slug: string;
  events: number;
  openIssues: number;
};

export async function overviewData(
  db: Database,
  member: AccessMember,
  filters: ActivityFilters,
  window: ReturnType<typeof activityWindow>,
) {
  const project = {
    ...projectScope(member),
    ...(filters.project ? { id: filters.project } : {}),
  };
  const eventScope = activityWhere(member, filters, window);
  const issueScope = {
    project,
    status: "open",
    eventCount: { gt: 0 },
    events: { some: eventScope },
  };
  const eventSql = Prisma.sql`e."projectId" = p.id AND e."receivedAt" >= ${window.start} AND e."receivedAt" < ${window.end}
    ${filters.environment !== "all" ? Prisma.sql`AND e.environment = ${filters.environment}` : Prisma.empty}`;
  const scopeSql = Prisma.sql`${projectScopeSql(member)} ${filters.project ? Prisma.sql`AND p.id = ${filters.project}` : Prisma.empty}`;
  const [projects, open, regressions, groups, health, recent] =
    await Promise.all([
      db.project.findMany({
        where: projectScope(member),
        orderBy: { name: "asc" },
        take: 200,
        select: { id: true, name: true },
      }),
      db.issue.count({ where: issueScope }),
      db.issue.count({ where: { ...issueScope, regression: true } }),
      db.errorEvent.groupBy({
        by: ["issueId"],
        where: {
          ...eventScope,
          issue: { status: "open", eventCount: { gt: 0 } },
        },
        _count: { _all: true },
        _max: { receivedAt: true },
        orderBy: [{ _count: { issueId: "desc" } }, { issueId: "asc" }],
        take: 5,
      }),
      db.$queryRaw<ProjectHealth[]>(Prisma.sql`
      SELECT p.id, p.name, p.slug,
        (SELECT count(*)::integer FROM error_event e WHERE ${eventSql}) AS events,
        (SELECT count(*)::integer FROM issue i WHERE i."projectId" = p.id AND i.status = 'open' AND i."eventCount" > 0
          AND EXISTS (SELECT 1 FROM error_event e WHERE e."issueId" = i.id AND ${eventSql})) AS "openIssues"
      FROM project p WHERE ${scopeSql} ORDER BY events DESC, p.name, p.id LIMIT 6
    `),
      db.$queryRaw<{ id: string; latest: Date }[]>(Prisma.sql`
      SELECT r.id, max(e."receivedAt") AS latest FROM release r JOIN project p ON p.id = r."projectId"
      JOIN error_event e ON e."projectId" = r."projectId" AND e.release = r.name
      WHERE ${scopeSql} AND ${eventSql} GROUP BY r.id ORDER BY latest DESC, r.id DESC LIMIT 4
    `),
    ]);
  const [issues, releaseRows] = await Promise.all([
    db.issue.findMany({
      where: { ...issueScope, id: { in: groups.map((row) => row.issueId) } },
      include: {
        project: { select: { name: true } },
        events: {
          where: eventScope,
          orderBy: [{ receivedAt: "desc" }, { id: "desc" }],
          take: 1,
          select: { eventId: true },
        },
      },
      take: 5,
    }),
    db.release.findMany({
      where: { project, id: { in: recent.map((row) => row.id) } },
      include: { project: { select: { name: true } }, deployments: true },
      take: 4,
    }),
  ]);

  return {
    projects,
    open,
    regressions,
    health,
    topIssues: groups.flatMap((group) => {
      const issue = issues.find((value) => value.id === group.issueId);

      return issue
        ? [
            {
              ...issue,
              matchingEvents: group._count._all,
              latest: group._max.receivedAt!,
              eventId: issue.events[0]?.eventId,
            },
          ]
        : [];
    }),
    releases: recent.flatMap((row) => {
      const release = releaseRows.find((value) => value.id === row.id);

      return release ? [{ ...release, latest: row.latest }] : [];
    }),
  };
}
