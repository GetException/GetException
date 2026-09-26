import { randomUUID } from "node:crypto";
import { z } from "zod";
import type { AuthService } from "./auth-service";
import { AuthError } from "./auth-error";
import {
  decryptSecret,
  digest,
  encryptSecret,
  recoveryCodes,
  verifyTotp,
} from "./crypto";

const codeInput = z.object({ code: z.string().regex(/^\d{6}$/) }).strict();

export class MfaService {
  constructor(private readonly auth: AuthService) {}

  private async pending(userId: string) {
    const credential = await this.auth.db.mfaCredential.findUnique({
      where: { userId_state: { userId, state: "pending" } },
    });

    if (
      !credential?.expiresAt ||
      credential.expiresAt.getTime() <= Date.now()
    ) {
      throw new AuthError(410, "mfa_enrollment_expired");
    }

    return credential;
  }

  async details(headers: Headers) {
    const current = await this.auth.authenticateEnrollment(headers);
    const credential = await this.pending(current.user.id);
    const secret = decryptSecret(
      credential.ciphertext,
      current.user.id,
      "pending",
      this.auth.config.TOTP_ENCRYPTION_KEY,
    );

    return {
      secret,
      uri: `otpauth://totp/GetException:${encodeURIComponent(current.user.email)}?secret=${secret}&issuer=GetException&algorithm=SHA1&digits=6&period=30`,
      expiresAt: credential.expiresAt,
    };
  }

  async finish(headers: Headers, input: unknown, ip: string) {
    const { code } = codeInput.parse(input);
    const current = await this.auth.authenticateEnrollment(headers);

    await this.auth.rateLimit(ip, current.user.email, "mfa_finish");

    return this.auth.db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "user" WHERE id = ${current.user.id} FOR UPDATE`;
      const [user, credential, session, member] = await Promise.all([
        tx.user.findUnique({ where: { id: current.user.id } }),
        tx.mfaCredential.findUnique({
          where: {
            userId_state: { userId: current.user.id, state: "pending" },
          },
        }),
        tx.session.findUnique({ where: { id: current.session.id } }),
        tx.member.findFirst({
          where: { userId: current.user.id, active: true },
        }),
      ]);

      if (
        !user ||
        user.disabled ||
        user.twoFactorEnabled ||
        !member ||
        !session ||
        session.mfaMethod !== "enrollment" ||
        session.mfaVerifiedAt ||
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

      await tx.mfaCredential.deleteMany({ where: { userId: user.id } });
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
}
