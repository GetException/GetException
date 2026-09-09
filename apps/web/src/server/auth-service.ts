import { AuthError } from "./auth-error";
import { loginSchema, prepareSetupSchema, stepUpSchema } from "./auth-schemas";
import { runWithAdapter } from "@better-auth/core/context";
import { createHmac, randomUUID } from "node:crypto";
import { type Database, type Transaction } from "@getexception/db";
import { createIdentity, type WebConfig } from "./identity";
import {
  constantEqual,
  decryptSecret,
  digest,
  encryptSecret,
  hashPassword,
  newTotpSecret,
  passwordAllowed,
  recoveryCodes,
  token,
  verifyPassword,
  verifyTotp,
} from "./crypto";

export class AuthService {
  private readonly dummyHash = hashPassword(token());

  constructor(
    public readonly db: Database,
    public readonly config: WebConfig,
  ) {}

  audit(
    db: Database | Transaction,
    action:
      | "setup_access"
      | "setup_prepare"
      | "setup_activate"
      | "password"
      | "totp"
      | "recovery"
      | "step_up"
      | "project_create"
      | "issue_resolve"
      | "issue_reopen"
      | "team_create"
      | "team_update"
      | "member_update"
      | "invitation_create"
      | "invitation_resend"
      | "invitation_revoke"
      | "invitation_accept"
      | "mfa_enable"
      | "mfa_disable",
    success: boolean,
    actorId?: string,
  ) {
    return db.auditLog.create({
      data: { id: randomUUID(), action, success, actorId },
    });
  }

  async rateLimit(
    ip: string,
    principal: string,
    action: string,
    now = Date.now(),
  ) {
    const window = Math.floor(now / 300_000);
    const identifiers = [
      `${action}:ip:${ip}`,
      `${action}:account:${principal.trim().toLowerCase()}`,
    ];
    // Upserts increment both buckets even when one is already blocked. No process-local state.
    const rows = await this.db.$transaction(
      identifiers.map((identifier) => {
        const id = createHmac("sha256", this.config.AUTH_RATE_KEY)
          .update(`${window}:${identifier}`)
          .digest("hex");

        return this.db.authRateBucket.upsert({
          where: { id },
          create: { id, hits: 1, expiresAt: new Date((window + 2) * 300_000) },
          update: { hits: { increment: 1 } },
        });
      }),
    );

    if (rows.some((row) => row.hits > 10)) {
      throw new AuthError(429);
    }
  }

  async setupAccess(provided: string, ip: string) {
    await this.rateLimit(ip, "setup", "setup");
    const bootstrap = await this.db.bootstrapToken.findUnique({
      where: { id: 1 },
    });
    const complete = await this.db.systemSetting.findUnique({
      where: { id: 1 },
    });
    const valid =
      !complete &&
      bootstrap &&
      bootstrap.expiresAt.getTime() > Date.now() &&
      constantEqual(digest(provided), bootstrap.tokenHash);

    await this.audit(this.db, "setup_access", Boolean(valid));

    if (!valid) {
      throw new AuthError();
    }

    const access = token();

    await this.db.setupSession.create({
      data: {
        id: randomUUID(),
        tokenHash: digest(access),
        userId: randomUUID(),
        domain: "",
        email: "",
        passwordHash: "",
        pendingCiphertext: "",
        expiresAt: new Date(Date.now() + 15 * 60_000),
      },
    });

    return access;
  }

  async setupSession(access: string, db: Database | Transaction = this.db) {
    const session = await db.setupSession.findUnique({
      where: { tokenHash: digest(access) },
    });

    if (
      !session ||
      session.expiresAt.getTime() <= Date.now() ||
      (await db.systemSetting.findUnique({ where: { id: 1 } }))
    ) {
      throw new AuthError();
    }

    return session;
  }

  async prepareSetup(access: string, input: unknown, ip: string) {
    const data = prepareSetupSchema.parse(input);
    const session = await this.setupSession(access);

    await this.rateLimit(ip, data.email, "setup_prepare");

    if (
      data.domain !== new URL(this.config.DASHBOARD_ORIGIN).hostname ||
      !passwordAllowed(data.password)
    ) {
      throw new AuthError(400);
    }

    const secret = newTotpSecret();
    const passwordHash = await hashPassword(data.password);

    await this.db.setupSession.update({
      where: { id: session.id },
      data: {
        email: data.email,
        domain: data.domain,
        passwordHash,
        pendingCiphertext: encryptSecret(
          secret,
          session.userId,
          "pending",
          this.config.TOTP_ENCRYPTION_KEY,
        ),
      },
    });
    await this.audit(this.db, "setup_prepare", true);

    return {
      secret,
      uri: `otpauth://totp/GetException:${encodeURIComponent(data.email)}?secret=${secret}&issuer=GetException&algorithm=SHA1&digits=6&period=30`,
    };
  }

  async finishSetup(access: string, code: string, ip: string) {
    await this.rateLimit(ip, "setup", "setup_activate");

    try {
      return await this.db.$transaction(
        async (tx) => {
          // The singleton bootstrap row serializes different pending setup sessions too.
          const locked = await tx.$queryRaw<
            { id: number }[]
          >`SELECT id FROM bootstrap_token WHERE id = 1 AND "expiresAt" > now() FOR UPDATE`;

          if (!locked.length) {
            throw new AuthError();
          }

          const session = await this.setupSession(access, tx);

          if (!session.pendingCiphertext || !session.passwordHash) {
            throw new AuthError();
          }

          const secret = decryptSecret(
            session.pendingCiphertext,
            session.userId,
            "pending",
            this.config.TOTP_ENCRYPTION_KEY,
          );
          const counter = verifyTotp(secret, code, -1n);

          if (counter === null) {
            throw new AuthError();
          }

          const identity = await createIdentity(tx, this.config).$context;
          const user = await runWithAdapter(identity.adapter, () =>
            identity.internalAdapter.createUser({
              id: session.userId,
              email: session.email,
              emailVerified: true,
              name: "Owner",
              twoFactorEnabled: true,
            }),
          );

          if (user.id !== session.userId) {
            throw new Error("Identity binding failed");
          }

          await runWithAdapter(identity.adapter, () =>
            identity.internalAdapter.createAccount({
              userId: user.id,
              accountId: user.id,
              providerId: "credential",
              password: session.passwordHash,
            }),
          );
          const organization = await tx.organization.create({
            data: {
              id: randomUUID(),
              name: "My workspace",
              slug: "workspace",
              singleton: 1,
            },
          });
          const member = await tx.member.create({
            data: {
              id: randomUUID(),
              userId: user.id,
              organizationId: organization.id,
              role: "owner",
            },
          });

          await tx.team.create({
            data: {
              id: randomUUID(),
              organizationId: organization.id,
              name: "Default",
              members: {
                create: {
                  id: randomUUID(),
                  userId: user.id,
                  memberId: member.id,
                },
              },
            },
          });
          await tx.mfaCredential.create({
            data: {
              id: randomUUID(),
              userId: user.id,
              state: "active",
              ciphertext: encryptSecret(
                secret,
                user.id,
                "active",
                this.config.TOTP_ENCRYPTION_KEY,
              ),
              lastCounter: counter,
            },
          });
          const codes = recoveryCodes();

          await tx.recoveryCode.createMany({
            data: codes.map((value) => ({
              id: randomUUID(),
              userId: user.id,
              codeHash: digest(value),
            })),
          });
          await tx.systemSetting.create({
            data: { id: 1, domain: session.domain },
          });
          await tx.bootstrapToken.delete({ where: { id: 1 } });
          await tx.setupSession.deleteMany();
          await this.audit(tx, "setup_activate", true, user.id);

          return { recoveryCodes: codes };
        },
        { timeout: 15_000 },
      );
    } catch (error) {
      await this.audit(this.db, "setup_activate", false);

      throw error;
    }
  }

  private async password(email: string, password: string) {
    const user = await this.db.user.findUnique({
      where: { email },
      include: {
        accounts: { where: { providerId: "credential" } },
        members: { where: { active: true } },
      },
    });
    const valid = await verifyPassword(
      user?.accounts[0]?.password ?? (await this.dummyHash),
      password,
    );
    const success = Boolean(
      valid && user && !user.disabled && user.emailVerified,
    );

    await this.audit(this.db, "password", success, user?.id);

    if (!success || !user) {
      throw new AuthError();
    }

    return user;
  }

  async consumeFactor(
    tx: Transaction,
    userId: string,
    code?: string,
    recoveryCode?: string,
  ) {
    const locked = await tx.$queryRaw<
      { id: string; ciphertext: string; lastCounter: bigint }[]
    >`SELECT id, ciphertext, "lastCounter" FROM mfa_credential WHERE "userId" = ${userId} AND state = 'active' FOR UPDATE`;
    const credential = locked[0];

    if (!credential) {
      throw new AuthError();
    }

    if (recoveryCode) {
      const consumed = await tx.recoveryCode.updateMany({
        where: { userId, codeHash: digest(recoveryCode), usedAt: null },
        data: { usedAt: new Date() },
      });

      if (consumed.count !== 1) {
        throw new AuthError();
      }
    } else {
      const secret = decryptSecret(
        credential.ciphertext,
        userId,
        "active",
        this.config.TOTP_ENCRYPTION_KEY,
      );
      const counter = verifyTotp(secret, code ?? "", credential.lastCounter);

      if (counter === null) {
        throw new AuthError();
      }

      await tx.mfaCredential.update({
        where: { id: credential.id },
        data: { lastCounter: counter },
      });
    }
  }

  async login(input: unknown, ip: string) {
    const data = loginSchema.parse(input);

    await this.rateLimit(ip, data.email, "login");
    const user = await this.password(data.email, data.password);

    try {
      return await this.db.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT id FROM workspace FOR SHARE`;
        const fresh = await tx.user.findUnique({
          where: { id: user.id },
          include: { members: { where: { active: true } } },
        });

        if (!fresh || fresh.disabled || !fresh.emailVerified) {
          throw new AuthError();
        }

        const owner = fresh.members.some((member) => member.role === "owner");

        if (owner && !fresh.twoFactorEnabled) {
          throw new AuthError();
        }

        if (fresh.twoFactorEnabled) {
          await this.consumeFactor(tx, user.id, data.code, data.recoveryCode);
        }

        const method = fresh.twoFactorEnabled
          ? data.recoveryCode
            ? "recovery"
            : "totp"
          : "password";
        const context = await createIdentity(tx, this.config).$context;
        const session = await runWithAdapter(context.adapter, () =>
          context.internalAdapter.createSession(
            user.id,
            false,
            {
              mfaVerifiedAt: method === "password" ? null : new Date(),
              mfaMethod: method,
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

        await this.audit(
          tx,
          method === "password" ? "password" : method,
          true,
          user.id,
        );

        return { user, session };
      });
    } catch (error) {
      await this.audit(
        this.db,
        data.recoveryCode ? "recovery" : "totp",
        false,
        user.id,
      );

      throw error;
    }
  }

  async authenticate(headers: Headers) {
    const found = await createIdentity(this.db, this.config).api.getSession({
      headers,
    });

    if (!found) {
      throw new AuthError(401);
    }

    const [user, session] = await Promise.all([
      this.db.user.findUnique({
        where: { id: found.user.id },
        include: { members: { where: { active: true } } },
      }),
      this.db.session.findUnique({ where: { id: found.session.id } }),
    ]);
    const now = Date.now();
    const owner = user?.members.some((member) => member.role === "owner");

    if (
      !user ||
      user.disabled ||
      !user.emailVerified ||
      !session ||
      session.expiresAt.getTime() <= now ||
      now - session.createdAt.getTime() > 8 * 3600_000 ||
      now - session.lastSeenAt.getTime() > 30 * 60_000 ||
      (owner && !user.twoFactorEnabled) ||
      ((owner || user.twoFactorEnabled) &&
        (!session.mfaVerifiedAt ||
          !["totp", "recovery"].includes(session.mfaMethod ?? "")))
    ) {
      throw new AuthError(401);
    }

    if (now - session.lastSeenAt.getTime() > 60_000) {
      await this.db.session.update({
        where: { id: session.id },
        data: { lastSeenAt: new Date() },
      });
    }

    return { user, session };
  }

  async authorize(headers: Headers, recent = false) {
    const current = await this.authenticate(headers);
    const member = current.user.members.find((member) =>
      ["owner", "developer", "viewer"].includes(member.role),
    );

    if (!member) {
      throw new AuthError(403);
    }

    if (
      recent &&
      (current.session.mfaMethod !== "totp" ||
        !current.session.mfaVerifiedAt ||
        Date.now() - current.session.mfaVerifiedAt.getTime() > 300_000)
    ) {
      throw new AuthError(428);
    }

    return { ...current, member };
  }

  async stepUp(headers: Headers, input: unknown, ip: string) {
    const data = stepUpSchema.parse(input);
    const current = await this.authorize(headers);

    await this.rateLimit(ip, current.user.email, "step_up");
    await this.password(current.user.email, data.password);

    try {
      await this.db.$transaction(async (tx) => {
        await this.consumeFactor(tx, current.user.id, data.code);
        await tx.session.update({
          where: { id: current.session.id },
          data: { mfaVerifiedAt: new Date(), mfaMethod: "totp" },
        });
        await this.audit(tx, "step_up", true, current.user.id);
      });
    } catch (error) {
      await this.audit(this.db, "step_up", false, current.user.id);

      throw error;
    }
  }
}
