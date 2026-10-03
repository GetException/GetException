import { Prisma, type Database } from "@getexception/db";
import { projectScopeSql, type AccessMember } from "../access";
import { sqlOrder, sqlPage } from "../table-order";
import type { TableSort } from "../../lib/table-sort";

export function projectPageIds(
  db: Database,
  member: AccessMember,
  q: string,
  sorting: TableSort,
  page: number,
) {
  const columns = {
    project: Prisma.sql`lower(p.name)`,
    teams: Prisma.sql`(SELECT string_agg(lower(t.name), ', ' ORDER BY lower(t.name)) FROM project_team pt JOIN team t ON t.id = pt."teamId" WHERE pt."projectId" = p.id)`,
    status: Prisma.sql`CASE WHEN p.enabled THEN 'Active' ELSE 'Disabled' END`,
    issues: Prisma.sql`(SELECT count(*) FROM issue i WHERE i."projectId" = p.id AND i.status = 'open' AND i."eventCount" > 0)`,
    events: Prisma.sql`(SELECT count(*) FROM error_event e WHERE e."projectId" = p.id)`,
    created: Prisma.sql`p."createdAt"`,
  };

  return db.$queryRaw<{ id: string }[]>(Prisma.sql`SELECT p.id FROM project p
    WHERE ${projectScopeSql(member)} ${q ? Prisma.sql`AND (p.name ILIKE ${`%${q}%`} OR p.slug ILIKE ${`%${q}%`})` : Prisma.empty}
    ORDER BY ${sqlOrder(columns, sorting, "created", Prisma.sql`p.id`)} ${sqlPage(page)}`);
}

export function ingestionKeyPageIds(
  db: Database,
  projectId: string,
  sorting: TableSort,
  page: number,
  now: Date,
) {
  const columns = {
    created: Prisma.sql`k."createdAt"`,
    expires: Prisma.sql`k."expiresAt"`,
    status: Prisma.sql`CASE WHEN k."revokedAt" IS NOT NULL THEN 'Revoked' WHEN k."expiresAt" < ${now} THEN 'Expired' ELSE 'Active' END`,
  };

  return db.$queryRaw<
    { id: string }[]
  >(Prisma.sql`SELECT k.id FROM project_ingestion_key k WHERE k."projectId" = ${projectId}
    ORDER BY ${sqlOrder(columns, sorting, "created", Prisma.sql`k.id`)} ${sqlPage(page)}`);
}
