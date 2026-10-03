import { Prisma, type Database } from "@getexception/db";
import { requireOwner, type AccessMember } from "../access";
import { sqlOrder, sqlPage } from "../table-order";
import type { TableSort } from "../../lib/table-sort";

export function memberPageIds(
  db: Database,
  member: AccessMember,
  q: string,
  sorting: TableSort,
  page: number,
) {
  requireOwner(member);
  const columns = {
    member: Prisma.sql`lower(u.name)`,
    role: Prisma.sql`m.role`,
    teams: Prisma.sql`(SELECT string_agg(lower(t.name), ', ' ORDER BY lower(t.name)) FROM team_member tm JOIN team t ON t.id = tm."teamId" WHERE tm."memberId" = m.id)`,
    mfa: Prisma.sql`CASE WHEN u."twoFactorEnabled" THEN 'Enabled' ELSE 'Not enabled' END`,
    status: Prisma.sql`CASE WHEN m.active AND NOT u.disabled THEN 'Active' ELSE 'Inactive' END`,
    joined: Prisma.sql`m."createdAt"`,
  };

  return db.$queryRaw<
    { id: string }[]
  >(Prisma.sql`SELECT m.id FROM member m JOIN "user" u ON u.id = m."userId"
    WHERE m."organizationId" = ${member.organizationId}
    ${q ? Prisma.sql`AND (u.name ILIKE ${`%${q}%`} OR u.email ILIKE ${`%${q}%`})` : Prisma.empty}
    ORDER BY ${sqlOrder(columns, sorting, "joined", Prisma.sql`m.id`)} ${sqlPage(page)}`);
}

export function invitationPageIds(
  db: Database,
  member: AccessMember,
  sorting: TableSort,
  page: number,
  now: Date,
) {
  requireOwner(member);
  const columns = {
    email: Prisma.sql`lower(i.email)`,
    role: Prisma.sql`i.role`,
    status: Prisma.sql`CASE WHEN i.status = 'pending' AND i."expiresAt" <= ${now} THEN 'expired' ELSE i.status END`,
    expires: Prisma.sql`i."expiresAt"`,
  };

  return db.$queryRaw<
    { id: string }[]
  >(Prisma.sql`SELECT i.id FROM invitation i WHERE i."organizationId" = ${member.organizationId}
    ORDER BY ${sqlOrder(columns, sorting, "expires", Prisma.sql`i.id`)} ${sqlPage(page)}`);
}
