import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthService } from "./auth-service";
import { AuthError } from "./auth-error";
import {
  decryptSecret,
  digest,
  encryptSecret,
  newTotpSecret,
  recoveryCodes,
  verifyPassword,
  verifyTotp,
} from "./crypto";

const passwordInput = z
  .object({ password: z.string().min(1).max(128) })
  .strict();
const codeInput = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();
const disableInput = z
  .object({
    password: z.string().min(1).max(128),
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    recoveryCode: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
  })
  .strict()
  .refine((value) => Boolean(value.code) !== Boolean(value.recoveryCode));

export class MfaService {
  constructor(private readonly auth: AuthService) {}

  private async password(userId: string, password: string) {
    const account = await this.auth.db.account.findFirst({
      where: { userId, providerId: "credential" },
    });

    if (
      !account?.password ||
      !(await verifyPassword(account.password, password))
    ) {
      throw new AuthError();
    }
  }

  async prepare(headers: Headers, input: unknown, ip: string) {
    const { password } = passwordInput.parse(input);
    const current = await this.auth.authorize(headers);

    await this.auth.rateLimit(ip, current.user.email, "mfa_prepare");
    await this.password(current.user.id, password);

    if (current.user.twoFactorEnabled) {
      throw new AuthError(409);
    }

    const secret = newTotpSecret();
    const data = {
      ciphertext: encryptSecret(
        secret,
        current.user.id,
        "pending",
        this.auth.config.TOTP_ENCRYPTION_KEY,
      ),
      expiresAt: new Date(Date.now() + 15 * 60_000),
      lastCounter: -1n,
    };

    await this.auth.db.mfaCredential.upsert({
      where: { userId_state: { userId: current.user.id, state: "pending" } },
      create: {
        id: randomUUID(),
        userId: current.user.id,
        state: "pending",
        ...data,
      },
      update: data,
    });

    return { secret };
  }

  async finish(headers: Headers, input: unknown, ip: string) {
    const { code } = codeInput.parse(input);
    const current = await this.auth.authorize(headers);

    await this.auth.rateLimit(ip, current.user.email, "mfa_finish");

    return this.auth.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workspace WHERE id = ${current.member.organizationId} FOR UPDATE`;
      const user = await tx.user.findUniqueOrThrow({
        where: { id: current.user.id },
      });
      const credential = await tx.mfaCredential.findUnique({
        where: { userId_state: { userId: user.id, state: "pending" } },
      });
      const session = await tx.session.findUnique({
        where: { id: current.session.id },
      });

      if (
        !session ||
        user.twoFactorEnabled ||
        !credential?.expiresAt ||
        credential.expiresAt.getTime() <= Date.now()
      ) {
        throw new AuthError();
      }

      const secret = decryptSecret(
        credential.ciphertext,
        user.id,
        "pending",
        this.auth.config.TOTP_ENCRYPTION_KEY,
      );
      const counter = verifyTotp(secret, code, -1n);

      if (counter === null) {
        throw new AuthError();
      }

      await tx.mfaCredential.delete({ where: { id: credential.id } });
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

      await tx.recoveryCode.deleteMany({ where: { userId: user.id } });
      await tx.recoveryCode.createMany({
        data: codes.map((value) => ({
          id: randomUUID(),
          userId: user.id,
          codeHash: digest(value),
        })),
      });
      await tx.user.update({
        where: { id: user.id },
        data: { twoFactorEnabled: true },
      });
      await tx.session.deleteMany({ where: { userId: user.id } });
      await this.auth.audit(tx, "mfa_enable", true, user.id);

      return { recoveryCodes: codes };
    });
  }

  async disable(headers: Headers, input: unknown, ip: string) {
    const data = disableInput.parse(input);
    const current = await this.auth.authorize(headers);

    await this.auth.rateLimit(ip, current.user.email, "mfa_disable");
    await this.password(current.user.id, data.password);

    return this.auth.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM workspace WHERE id = ${current.member.organizationId} FOR UPDATE`;
      const member = await tx.member.findUniqueOrThrow({
        where: { id: current.member.id },
      });
      const session = await tx.session.findUnique({
        where: { id: current.session.id },
      });

      if (!session || member.role === "owner" || !member.active) {
        throw new AuthError(403);
      }

      await this.auth.consumeFactor(
        tx,
        current.user.id,
        data.code,
        data.recoveryCode,
      );
      await tx.mfaCredential.deleteMany({ where: { userId: current.user.id } });
      await tx.recoveryCode.deleteMany({ where: { userId: current.user.id } });
      await tx.user.update({
        where: { id: current.user.id },
        data: { twoFactorEnabled: false },
      });
      await tx.session.deleteMany({ where: { userId: current.user.id } });
      await this.auth.audit(tx, "mfa_disable", true, current.user.id);

      return { ok: true };
    });
  }
}
