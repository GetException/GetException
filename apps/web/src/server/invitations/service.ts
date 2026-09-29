import { randomUUID } from "node:crypto";
import { runWithAdapter } from "@better-auth/core/context";
import type { Transaction } from "@getexception/db";
import type { AuthService } from "../auth-service";
import { AuthError } from "../auth-error";
import { createIdentity } from "../identity";
import {
  decryptSecret,
  digest,
  encryptSecret,
  hashPassword,
  newTotpSecret,
  passwordAllowed,
  recoveryCodes,
  token,
  verifyTotp,
} from "../crypto";
import { ownerTransaction } from "../owner-transaction";
import {
  codeInput,
  invitationInput,
  registrationInput,
  ENROLLMENT_TTL,
  INVITATION_TTL,
} from "./schemas";

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

  private async clearLegacyDelivery(tx: Transaction, invitationId: string) {
    await tx.invitationVerification.deleteMany({ where: { invitationId } });
    await tx.mailOutbox.updateMany({
      where: {
        invitationId,
        status: { in: ["pending", "processing"] },
      },
      data: {
        payload: null,
        status: "cancelled",
        leaseToken: null,
        leaseUntil: null,
      },
    });
    await tx.mailOutbox.updateMany({
      where: {
        invitationId,
        status: { notIn: ["pending", "processing"] },
      },
      data: {
        payload: null,
        leaseToken: null,
        leaseUntil: null,
      },
    });
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

      await this.auth.audit(tx, "invitation_create", true, current.user.id);

      return {
        id: invitation.id,
        token: value,
        expiresAt: invitation.expiresAt,
      };
    });
  }

  async change(headers: Headers, id: string, action: "reissue" | "revoke") {
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

      if (action === "reissue") {
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

      await tx.invitationEnrollment.deleteMany({ where: { invitationId: id } });
      await this.clearLegacyDelivery(tx, id);
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

      await this.auth.audit(
        tx,
        action === "reissue" ? "invitation_reissue" : "invitation_revoke",
        true,
        current.user.id,
      );

      return action === "reissue"
        ? { id: invitation.id, token: value, expiresAt: invitation.expiresAt }
        : { ok: true };
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

  async beginRegistration(value: string, input: unknown, ip: string) {
    const data = registrationInput.parse(input);
    const found = await this.find(value);

    await this.auth.rateLimit(ip, found.id, "invitation_register");

    if (!passwordAllowed(data.password)) {
      throw new AuthError(400);
    }

    if (await this.auth.db.user.findUnique({ where: { email: found.email } })) {
      throw new AuthError(409, "account_exists");
    }

    const passwordHash = await hashPassword(data.password);
    const enrollmentToken = token();
    const enrollmentId = randomUUID();
    const secret = newTotpSecret();
    const expiresAt = new Date(Date.now() + ENROLLMENT_TTL);

    await this.auth.db.$transaction(async (tx) => {
      const invitation = await this.lock(tx, found.id);

      if (invitation.tokenHash !== digest(value)) {
        throw new AuthError(410);
      }

      if (await tx.user.findUnique({ where: { email: invitation.email } })) {
        throw new AuthError(409, "account_exists");
      }

      await tx.invitationEnrollment.deleteMany({
        where: { invitationId: invitation.id },
      });
      await tx.invitationEnrollment.create({
        data: {
          id: enrollmentId,
          invitationId: invitation.id,
          revision: invitation.revision,
          tokenHash: digest(enrollmentToken),
          name: data.name,
          passwordHash,
          pendingCiphertext: encryptSecret(
            secret,
            enrollmentId,
            "pending",
            this.auth.config.TOTP_ENCRYPTION_KEY,
          ),
          expiresAt,
        },
      });
    });

    return {
      enrollmentToken,
      secret,
      uri: `otpauth://totp/GetException:${encodeURIComponent(found.email)}?secret=${secret}&issuer=GetException&algorithm=SHA1&digits=6&period=30`,
      expiresAt,
    };
  }

  private async enrollment(value: string, tx: Transaction = this.auth.db) {
    if (!/^[a-f0-9]{64}$/.test(value)) {
      throw new AuthError(410);
    }

    const enrollment = await tx.invitationEnrollment.findUnique({
      where: { tokenHash: digest(value) },
      include: { invitation: { include: { teams: true } } },
    });

    if (
      !enrollment ||
      enrollment.expiresAt.getTime() <= Date.now() ||
      enrollment.invitation.status !== "pending" ||
      enrollment.invitation.expiresAt.getTime() <= Date.now() ||
      enrollment.revision !== enrollment.invitation.revision
    ) {
      throw new AuthError(410);
    }

    return enrollment;
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
    await tx.invitationEnrollment.deleteMany({
      where: { invitationId: invitation.id },
    });
    await this.clearLegacyDelivery(tx, invitation.id);
    await this.auth.audit(tx, "invitation_accept", true, userId);
  }

  async finishRegistration(value: string, input: unknown, ip: string) {
    const { code } = codeInput.parse(input);
    const found = await this.enrollment(value);

    await this.auth.rateLimit(ip, found.invitation.email, "invitation_finish");

    return this.auth.db.$transaction(
      async (tx) => {
        const invitation = await this.lock(tx, found.invitationId);

        await tx.$queryRaw`SELECT id FROM invitation_enrollment WHERE id = ${found.id} FOR UPDATE`;
        const enrollment = await this.enrollment(value, tx);

        if (await tx.user.findUnique({ where: { email: invitation.email } })) {
          throw new AuthError(409, "account_exists");
        }

        const secret = decryptSecret(
          enrollment.pendingCiphertext,
          enrollment.id,
          "pending",
          this.auth.config.TOTP_ENCRYPTION_KEY,
        );
        const counter = verifyTotp(secret, code, -1n);

        if (counter === null) {
          throw new AuthError();
        }

        const userId = randomUUID();
        const context = await createIdentity(tx, this.auth.config).$context;
        const user = await runWithAdapter(context.adapter, () =>
          context.internalAdapter.createUser({
            id: userId,
            name: enrollment.name,
            email: invitation.email,
            emailVerified: true,
            twoFactorEnabled: true,
          }),
        );

        await runWithAdapter(context.adapter, () =>
          context.internalAdapter.createAccount({
            userId: user.id,
            accountId: user.id,
            providerId: "credential",
            password: enrollment.passwordHash,
          }),
        );
        await tx.mfaCredential.create({
          data: {
            id: randomUUID(),
            userId: user.id,
            state: "active",
            lastCounter: counter,
            ciphertext: encryptSecret(
              secret,
              user.id,
              "active",
              this.auth.config.TOTP_ENCRYPTION_KEY,
            ),
          },
        });
        const codes = recoveryCodes();

        await tx.recoveryCode.createMany({
          data: codes.map((recoveryCode) => ({
            id: randomUUID(),
            userId: user.id,
            codeHash: digest(recoveryCode),
          })),
        });
        await this.join(tx, invitation, user.id);

        const session = await runWithAdapter(context.adapter, () =>
          context.internalAdapter.createSession(
            user.id,
            false,
            {
              mfaVerifiedAt: new Date(),
              mfaMethod: "totp",
              lastSeenAt: new Date(),
              ipAddress: null,
              userAgent: null,
            },
            true,
          ),
        );

        if (!session) {
          throw new AuthError();
        }

        return { recoveryCodes: codes, user, session };
      },
      { timeout: 15_000 },
    );
  }

  async accept(headers: Headers, value: string) {
    const current = await this.auth.authenticate(headers);
    const found = await this.find(value);

    return this.auth.db.$transaction(async (tx) => {
      const invitation = await this.lock(tx, found.id);

      if (invitation.tokenHash !== digest(value)) {
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
