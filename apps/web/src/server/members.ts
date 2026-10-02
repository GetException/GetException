import { randomUUID } from "node:crypto";
import { z } from "zod";
import { ownerTransaction } from "./owner-transaction";
import { AuthError } from "./auth-error";
import type { AuthService } from "./auth-service";

const ids = z
  .array(z.string().uuid())
  .max(100)
  .transform((values) => [...new Set(values)]);
const teamInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    memberIds: ids,
    projectIds: ids,
  })
  .strict();
const memberInput = z
  .object({
    role: z.enum(["owner", "developer", "viewer"]),
    active: z.boolean(),
    teamIds: ids,
  })
  .strict();
const deleteMemberInput = z
  .object({ email: z.string().trim().toLowerCase().email().max(254) })
  .strict();

export async function deleteMember(
  service: AuthService,
  headers: Headers,
  id: string,
  input: unknown,
) {
  const data = deleteMemberInput.parse(input);

  return ownerTransaction(service, headers, async (tx, current) => {
    const member = await tx.member.findFirst({
      where: { id, organizationId: current.member.organizationId },
      include: { user: true },
    });

    if (!member) {
      throw new AuthError(404);
    }

    if (member.userId === current.user.id) {
      throw new AuthError(409, "member_self_delete");
    }

    if (data.email !== member.user.email) {
      throw new AuthError(400, "member_confirmation");
    }

    // Keep a usable Owner even when deleting another Owner or racing a role change.
    if (
      !(await tx.member.count({
        where: {
          organizationId: current.member.organizationId,
          userId: { not: member.userId },
          role: "owner",
          active: true,
          user: { disabled: false, twoFactorEnabled: true },
        },
      }))
    ) {
      throw new AuthError(409, "last_owner");
    }

    // Invitations reference their creator. Remove both directions and their
    // pending enrollments so no previously issued link can recreate access.
    await tx.invitation.deleteMany({
      where: {
        organizationId: current.member.organizationId,
        OR: [{ email: member.user.email }, { inviterId: member.userId }],
      },
    });
    // Foreign keys cascade to credentials, sessions, membership and team links.
    await tx.user.delete({ where: { id: member.userId } });
    await service.audit(tx, "member_delete", true, current.user.id);

    return { ok: true };
  });
}

export async function saveTeam(
  service: AuthService,
  headers: Headers,
  id: string | undefined,
  input: unknown,
) {
  const data = teamInput.parse(input);

  return ownerTransaction(service, headers, async (tx, current) => {
    const organizationId = current.member.organizationId;
    const members = await tx.member.findMany({
      where: { id: { in: data.memberIds }, organizationId },
    });

    if (
      members.length !== data.memberIds.length ||
      (await tx.project.count({
        where: { id: { in: data.projectIds }, organizationId, deletedAt: null },
      })) !== data.projectIds.length
    ) {
      throw new AuthError(400);
    }

    let teamId = id;

    if (teamId) {
      const team = await tx.team.findFirst({
        where: { id: teamId, organizationId },
        include: {
          projects: { where: { project: { deletedAt: null } } },
          members: true,
        },
      });

      if (!team) {
        throw new AuthError(404);
      }

      for (const project of team.projects.filter(
        (project) => !data.projectIds.includes(project.projectId),
      )) {
        if (
          !(await tx.projectTeam.count({
            where: { projectId: project.projectId, teamId: { not: teamId } },
          }))
        ) {
          throw new AuthError(409, "project_team");
        }
      }

      await tx.team.update({
        where: { id: teamId },
        data: { name: data.name },
      });
      await tx.teamMember.deleteMany({ where: { teamId } });
      await tx.projectTeam.deleteMany({
        where: { teamId, project: { deletedAt: null } },
      });
      const affected = [
        ...new Set([
          ...members.map((member) => member.userId),
          ...team.members.map((member) => member.userId),
        ]),
      ];

      // Access is also re-evaluated against memberships on every query.
      await tx.session.deleteMany({
        where: {
          userId: { in: affected },
          user: { members: { none: { role: "owner", active: true } } },
        },
      });
    } else {
      teamId = randomUUID();
      await tx.team.create({
        data: { id: teamId, organizationId, name: data.name },
      });
    }

    await tx.teamMember.createMany({
      data: members.map((member) => ({
        id: randomUUID(),
        teamId,
        memberId: member.id,
        userId: member.userId,
      })),
    });
    await tx.projectTeam.createMany({
      data: data.projectIds.map((projectId) => ({ projectId, teamId })),
    });
    await service.audit(
      tx,
      id ? "team_update" : "team_create",
      true,
      current.user.id,
    );

    return { id: teamId };
  });
}

export async function saveMember(
  service: AuthService,
  headers: Headers,
  id: string,
  input: unknown,
) {
  const data = memberInput.parse(input);

  return ownerTransaction(service, headers, async (tx, current) => {
    const organizationId = current.member.organizationId;
    const member = await tx.member.findFirst({
      where: { id, organizationId },
      include: { user: true },
    });

    if (!member) {
      throw new AuthError(404);
    }

    if (
      (await tx.team.count({
        where: { id: { in: data.teamIds }, organizationId },
      })) !== data.teamIds.length
    ) {
      throw new AuthError(400);
    }

    if (
      member.role === "owner" &&
      member.active &&
      (!data.active || data.role !== "owner") &&
      (await tx.member.count({
        where: {
          organizationId,
          role: "owner",
          active: true,
          user: { disabled: false },
        },
      })) <= 1
    ) {
      throw new AuthError(409, "last_owner");
    }

    if (
      data.role === "owner" &&
      data.active &&
      (!member.user.twoFactorEnabled ||
        !(await tx.mfaCredential.findUnique({
          where: { userId_state: { userId: member.userId, state: "active" } },
        })))
    ) {
      throw new AuthError(409, "owner_mfa");
    }

    await tx.member.update({
      where: { id },
      data: { role: data.role, active: data.active },
    });
    await tx.teamMember.deleteMany({ where: { memberId: id } });
    await tx.teamMember.createMany({
      data: data.teamIds.map((teamId) => ({
        id: randomUUID(),
        teamId,
        memberId: id,
        userId: member.userId,
      })),
    });
    await tx.session.deleteMany({ where: { userId: member.userId } });
    await service.audit(tx, "member_update", true, current.user.id);

    return { ok: true, signedOut: member.userId === current.user.id };
  });
}
