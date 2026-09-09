import type { Prisma } from "@getexception/db";
import { AuthError } from "./auth-error";

export interface AccessMember {
  id: string;
  organizationId: string;
  role: string;
}

export function projectScope(member: AccessMember): Prisma.ProjectWhereInput {
  return {
    organizationId: member.organizationId,
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

export function requireOwner(member: AccessMember) {
  if (member.role !== "owner") {
    throw new AuthError(403);
  }
}

export function canResolve(member: AccessMember) {
  return member.role === "owner" || member.role === "developer";
}
