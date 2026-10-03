import { Prisma } from "@getexception/db";
import { AuthError } from "./auth-error";

export interface AccessMember {
  id: string;
  organizationId: string;
  role: string;
}

export function projectScope(member: AccessMember): Prisma.ProjectWhereInput {
  return {
    organizationId: member.organizationId,
    deletedAt: null,
    ...(member.role === "owner"
      ? {}
      : {
          teams: {
            some: {
              team: {
                members: {
                  some: { memberId: member.id, member: { active: true } },
                },
              },
            },
          },
        }),
  };
}

export function teamScope(member: AccessMember): Prisma.TeamWhereInput {
  return {
    organizationId: member.organizationId,
    ...(member.role === "owner"
      ? {}
      : {
          members: { some: { memberId: member.id, member: { active: true } } },
        }),
  };
}

// Matches projectScope for aggregate list queries; their project table alias is p.
export function projectScopeSql(member: AccessMember) {
  return Prisma.sql`p."organizationId" = ${member.organizationId} AND p."deletedAt" IS NULL
    ${
      member.role === "owner"
        ? Prisma.empty
        : Prisma.sql`AND EXISTS (
      SELECT 1 FROM project_team pt
      JOIN team_member tm ON tm."teamId" = pt."teamId"
      JOIN member m ON m.id = tm."memberId"
      WHERE pt."projectId" = p.id AND tm."memberId" = ${member.id} AND m.active = true
    )`
    }`;
}

export function requireOwner(member: AccessMember) {
  if (member.role !== "owner") {
    throw new AuthError(403);
  }
}

export function canResolve(member: AccessMember) {
  return member.role === "owner" || member.role === "developer";
}
