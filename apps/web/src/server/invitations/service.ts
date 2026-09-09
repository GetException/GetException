import { randomUUID } from "node:crypto";
import { runWithAdapter } from "@better-auth/core/context";
import type { Transaction } from "@getexception/db";
import type { AuthService } from "../auth-service";
import { AuthError } from "../auth-error";
import { createIdentity } from "../identity";
import { digest, hashPassword, passwordAllowed, token } from "../crypto";
import { ownerTransaction } from "../owner-transaction";
import {
  invitationInput,
  registrationInput,
  INVITATION_TTL,
  VERIFICATION_TTL,
} from "./schemas";
import { cancelInvitationMail, queueInvitationMail } from "./mail";

export class InvitationService {
  constructor(private readonly auth: AuthService) {}

  private async lock(tx: Transaction, id: string) {
    const found = await tx.invitation.findUnique({ where: { id } });

    if (!found) {
      throw new AuthError(404);
    }

    await tx.$queryRaw`SELECT id FROM workspace WHERE id = ${found.organizationId} FOR SHARE`;
    await tx.$queryRaw`SELECT id FROM invitation WHERE id = ${id} FOR UPDATE`;
    const invitation = await tx.invitation.findUniqueOrThrow({
      where: { id },
      include: { teams: true },
    });

    if (
      invitation.status !== "pending" ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      throw new AuthError(410);
    }

    return invitation;
  }

  private async find(value: string) {
    if (!/^[a-f0-9]{64}$/.test(value)) {
      throw new AuthError(404);
    }

    const invitation = await this.auth.db.invitation.findUnique({
      where: { tokenHash: digest(value) },
    });

    if (
      !invitation ||
      invitation.status !== "pending" ||
      invitation.expiresAt.getTime() <= Date.now()
    ) {
      throw new AuthError(410);
    }

    return invitation;
  }

  async create(headers: Headers, input: unknown) {
    const data = invitationInput.parse(input);

    return ownerTransaction(this.auth, headers, async (tx, current) => {
      const organizationId = current.member.organizationId;
      const teams = await tx.team.count({
        where: { id: { in: data.teamIds }, organizationId },
      });

      if (teams !== data.teamIds.length) {
        throw new AuthError(400);
      }

      if (
        await tx.member.findFirst({
          where: { organizationId, user: { email: data.email } },
        })
      ) {
        throw new AuthError(409, "member_exists");
      }

      await tx.invitation.updateMany({
        where: {
          organizationId,
          email: data.email,
          status: "pending",
          expiresAt: { lte: new Date() },
        },
        data: { status: "expired", tokenHash: null },
      });

      if (
        await tx.invitation.findFirst({
          where: { organizationId, email: data.email, status: "pending" },
        })
      ) {
        throw new AuthError(409, "invitation_pending");
      }

      const value = token();
      const invitation = await tx.invitation.create({
        data: {
          id: randomUUID(),
          organizationId,
          inviterId: current.user.id,
          email: data.email,
          role: data.role,
          tokenHash: digest(value),
          expiresAt: new Date(Date.now() + INVITATION_TTL),
          teams: { create: data.teamIds.map((teamId) => ({ teamId })) },
        },
      });

      await this.send(tx, invitation, value);
      await this.auth.audit(tx, "invitation_create", true, current.user.id);

      return { id: invitation.id };
    });
  }

  private async send(
    tx: Transaction,
    invitation: { id: string; email: string; expiresAt: Date },
    value: string,
  ) {
    await queueInvitationMail(
      tx,
      invitation.id,
      "invitation",
      {
        to: invitation.email,
        subject: "Your GetException invitation",
        text: `You have been invited to GetException. Review your invitation:\n\n${this.auth.config.DASHBOARD_ORIGIN}/invite#${value}\n\nThis link expires in 48 hours. If you were not expecting it, ignore this email.`,
      },
      invitation.expiresAt,
      this.auth.config.MAIL_ENCRYPTION_KEY,
    );
  }

  async change(headers: Headers, id: string, action: "resend" | "revoke") {
    return ownerTransaction(this.auth, headers, async (tx, current) => {
      const existing = await tx.invitation.findFirst({
        where: { id, organizationId: current.member.organizationId },
      });

      if (!existing) {
        throw new AuthError(404);
      }

      await tx.$queryRaw`SELECT id FROM invitation WHERE id = ${id} FOR UPDATE`;
      const fresh = await tx.invitation.findUniqueOrThrow({ where: { id } });

      if (!["pending", "expired"].includes(fresh.status)) {
        throw new AuthError(409);
      }

      if (action === "resend") {
        if (
          await tx.member.findFirst({
            where: {
              organizationId: fresh.organizationId,
              user: { email: fresh.email },
            },
          })
        ) {
          throw new AuthError(409, "member_exists");
        }

        if (
          await tx.invitation.findFirst({
            where: {
              organizationId: fresh.organizationId,
              email: fresh.email,
              status: "pending",
              id: { not: id },
              expiresAt: { gt: new Date() },
            },
          })
        ) {
          throw new AuthError(409, "invitation_pending");
        }

        await tx.invitation.updateMany({
          where: {
            organizationId: fresh.organizationId,
            email: fresh.email,
            status: "pending",
            id: { not: id },
            expiresAt: { lte: new Date() },
          },
          data: { status: "expired", tokenHash: null },
        });
      }

      await cancelInvitationMail(tx, id);
      await tx.invitationVerification.deleteMany({
        where: { invitationId: id },
      });
      const value = token();
      const invitation = await tx.invitation.update({
        where: { id },
        data: {
          revision: { increment: 1 },
          status: action === "revoke" ? "revoked" : "pending",
          tokenHash: action === "revoke" ? null : digest(value),
          expiresAt: new Date(Date.now() + INVITATION_TTL),
        },
      });

      if (action === "resend") {
        await this.send(tx, invitation, value);
      }

      await this.auth.audit(
        tx,
        action === "resend" ? "invitation_resend" : "invitation_revoke",
        true,
        current.user.id,
      );

      return { ok: true };
    });
  }

  async preview(value: string) {
    const invitation = await this.find(value);
    const [workspace, inviter, teams] = await Promise.all([
      this.auth.db.organization.findUniqueOrThrow({
        where: { id: invitation.organizationId },
        select: { name: true },
      }),
      this.auth.db.user.findUniqueOrThrow({
        where: { id: invitation.inviterId },
        select: { name: true },
      }),
      this.auth.db.team.findMany({
        where: {
          id: {
            in: (
              await this.auth.db.invitationTeam.findMany({
                where: { invitationId: invitation.id },
              })
            ).map((team) => team.teamId),
          },
          organizationId: invitation.organizationId,
        },
        select: { name: true },
      }),
    ]);
    const [local, domain] = invitation.email.split("@");

    return {
      workspace: workspace.name,
      inviter: inviter.name,
      role: invitation.role,
      email: `${local?.slice(0, 1)}***@${domain}`,
      teams: teams.map((team) => team.name),
    };
  }

  async requestVerification(value: string, ip: string) {
    const found = await this.find(value);

    await this.auth.rateLimit(ip, found.id, "invitation_email");
    await this.auth.db.$transaction(async (tx) => {
      const invitation = await this.lock(tx, found.id);

      if (invitation.tokenHash !== digest(value)) {
        throw new AuthError(410);
      }

      const previous = await tx.mailOutbox.findUnique({
        where: {
          invitationId_kind: {
            invitationId: invitation.id,
            kind: "verification",
          },
        },
      });

      if (previous && previous.nextAttemptAt.getTime() > Date.now() - 30_000) {
        throw new AuthError(429);
      }

      await tx.invitationVerification.deleteMany({
        where: { invitationId: invitation.id },
      });
      const verification = token();
      const expiresAt = new Date(
        Math.min(invitation.expiresAt.getTime(), Date.now() + VERIFICATION_TTL),
      );

      await tx.invitationVerification.create({
        data: {
          id: randomUUID(),
          invitationId: invitation.id,
          revision: invitation.revision,
          tokenHash: digest(verification),
          expiresAt,
        },
      });
      await queueInvitationMail(
        tx,
        invitation.id,
        "verification",
        {
          to: invitation.email,
          subject: "Confirm your email for GetException",
          text: `Confirm your email before creating your account:\n\n${this.auth.config.DASHBOARD_ORIGIN}/invite/verify#${verification}\n\nThis link expires in 15 minutes. Ignore it if you did not request it.`,
        },
        expiresAt,
        this.auth.config.MAIL_ENCRYPTION_KEY,
      );
    });

    return { ok: true };
  }

  async verifyEmail(value: string, ip: string) {
    await this.auth.rateLimit(ip, "invitation", "invitation_verify");
    const proof = await this.auth.db.invitationVerification.findUnique({
      where: { tokenHash: digest(value) },
    });

    if (!proof) {
      throw new AuthError(410);
    }

    return this.auth.db.$transaction(async (tx) => {
      const invitation = await this.lock(tx, proof.invitationId);
      const current = await tx.invitationVerification.findUnique({
        where: { id: proof.id },
      });

      if (
        !current ||
        current.tokenHash !== digest(value) ||
        current.revision !== invitation.revision ||
        current.expiresAt.getTime() <= Date.now()
      ) {
        throw new AuthError(410);
      }

      const registration = token();

      await tx.invitationVerification.update({
        where: { id: proof.id },
        data: {
          tokenHash: null,
          registrationHash: digest(registration),
          registrationExpiresAt: new Date(Date.now() + VERIFICATION_TTL),
        },
      });

      return registration;
    });
  }

  private async registration(value: string, tx: Transaction = this.auth.db) {
    if (!value) {
      throw new AuthError(410);
    }

    const proof = await tx.invitationVerification.findUnique({
      where: { registrationHash: digest(value) },
      include: { invitation: true },
    });

    if (
      !proof ||
      !proof.registrationExpiresAt ||
      proof.registrationExpiresAt.getTime() <= Date.now() ||
      proof.invitation.status !== "pending" ||
      proof.invitation.expiresAt.getTime() <= Date.now() ||
      proof.revision !== proof.invitation.revision
    ) {
      throw new AuthError(410);
    }

    return proof;
  }

  async registrationDetails(value: string) {
    const proof = await this.registration(value);
    const existing = await this.auth.db.user.findUnique({
      where: { email: proof.invitation.email },
      select: { id: true },
    });

    // Only an email-verified registration session can learn that an account already exists.
    return {
      email: proof.invitation.email,
      existingAccount: Boolean(existing),
    };
  }

  private async join(
    tx: Transaction,
    invitation: Awaited<ReturnType<InvitationService["lock"]>>,
    userId: string,
  ) {
    if (
      await tx.member.findUnique({
        where: {
          organizationId_userId: {
            organizationId: invitation.organizationId,
            userId,
          },
        },
      })
    ) {
      throw new AuthError(409, "member_exists");
    }

    const teamIds = invitation.teams.map((team) => team.teamId);

    if (
      !teamIds.length ||
      (await tx.team.count({
        where: {
          id: { in: teamIds },
          organizationId: invitation.organizationId,
        },
      })) !== teamIds.length
    ) {
      throw new AuthError(409);
    }

    const member = await tx.member.create({
      data: {
        id: randomUUID(),
        organizationId: invitation.organizationId,
        userId,
        role: invitation.role,
      },
    });

    await tx.teamMember.createMany({
      data: teamIds.map((teamId) => ({
        id: randomUUID(),
        teamId,
        memberId: member.id,
        userId,
      })),
    });
    await tx.invitation.update({
      where: { id: invitation.id },
      data: { status: "accepted", tokenHash: null, acceptedAt: new Date() },
    });
    await tx.invitationVerification.deleteMany({
      where: { invitationId: invitation.id },
    });
    await cancelInvitationMail(tx, invitation.id);
    await this.auth.audit(tx, "invitation_accept", true, userId);
  }

  async register(value: string, input: unknown, ip: string) {
    const data = registrationInput.parse(input);
    const proof = await this.registration(value);

    await this.auth.rateLimit(
      ip,
      proof.invitation.email,
      "invitation_register",
    );

    if (!passwordAllowed(data.password)) {
      throw new AuthError(400);
    }

    const password = await hashPassword(data.password);

    return this.auth.db.$transaction(
      async (tx) => {
        const invitation = await this.lock(tx, proof.invitationId);

        await this.registration(value, tx);

        if (await tx.user.findUnique({ where: { email: invitation.email } })) {
          throw new AuthError(409);
        }

        const context = await createIdentity(tx, this.auth.config).$context;
        const user = await runWithAdapter(context.adapter, () =>
          context.internalAdapter.createUser({
            id: randomUUID(),
            name: data.name,
            email: invitation.email,
            emailVerified: true,
            twoFactorEnabled: false,
          }),
        );

        await runWithAdapter(context.adapter, () =>
          context.internalAdapter.createAccount({
            userId: user.id,
            accountId: user.id,
            providerId: "credential",
            password,
          }),
        );
        await this.join(tx, invitation, user.id);

        return { ok: true };
      },
      { timeout: 15000 },
    );
  }

  async accept(headers: Headers, value: string, verified = false) {
    const current = await this.auth.authenticate(headers);
    const found = verified
      ? (await this.registration(value)).invitation
      : await this.find(value);

    return this.auth.db.$transaction(async (tx) => {
      const invitation = await this.lock(tx, found.id);

      if (verified) {
        await this.registration(value, tx);
      } else if (invitation.tokenHash !== digest(value)) {
        throw new AuthError(410);
      }

      if (invitation.email !== current.user.email) {
        throw new AuthError(403, "invitation_email");
      }

      const session = await tx.session.findUnique({
        where: { id: current.session.id },
      });

      if (!session) {
        throw new AuthError(401);
      }

      await this.join(tx, invitation, current.user.id);

      return { ok: true };
    });
  }
}
