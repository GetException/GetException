import { Prisma, type Database } from "@getexception/db";
import { requireOwner, type AccessMember } from "../access";
import { sqlOrder, sqlPage } from "../table-order";
import type { TableSort } from "../../lib/table-sort";
import { actions } from "../../app/(dashboard)/audit-log/constants";

export function auditPageIds(
  db: Database,
  member: AccessMember,
  action: string,
  outcome: string,
  sorting: TableSort,
  page: number,
) {
  requireOwner(member);
  const columns = {
    time: Prisma.sql`a."createdAt"`,
    action: Prisma.sql`CASE a.action ${Prisma.join(
      Object.entries(actions).map(
        ([key, value]) => Prisma.sql`WHEN ${key} THEN ${value}`,
      ),
      " ",
    )} ELSE a.action END`,
    actor: Prisma.sql`lower(coalesce(u.email, CASE WHEN a."actorId" IS NULL THEN 'System / unidentified account' ELSE 'Former member' END))`,
    result: Prisma.sql`CASE WHEN a.success THEN 'Success' ELSE 'Failure' END`,
  };

  return db.$queryRaw<
    { id: string }[]
  >(Prisma.sql`SELECT a.id FROM audit_log a LEFT JOIN "user" u ON u.id = a."actorId"
    WHERE true ${Object.hasOwn(actions, action) ? Prisma.sql`AND a.action = ${action}` : Prisma.empty}
    ${["success", "failure"].includes(outcome) ? Prisma.sql`AND a.success = ${outcome === "success"}` : Prisma.empty}
    ORDER BY ${sqlOrder(columns, sorting, "time", Prisma.sql`a.id`)} ${sqlPage(page)}`);
}
