import { randomUUID } from "node:crypto";
import { betterAuth, type BetterAuthPlugin } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { organization, twoFactor } from "better-auth/plugins";
import type { Database, Transaction } from "@getexception/db";
import type { webConfig } from "@getexception/config";
import { hashPassword, verifyPassword } from "./crypto";

export type WebConfig = ReturnType<typeof webConfig>;

export function createIdentity(
  db: Database | Transaction,
  config: WebConfig,
  extraPlugins: BetterAuthPlugin[] = [],
) {
  return betterAuth({
    appName: "GetException",
    baseURL: config.DASHBOARD_ORIGIN,
    basePath: "/api/auth",
    secret: config.BETTER_AUTH_SECRET,
    database: prismaAdapter(db, { provider: "postgresql" }),
    trustedOrigins: [config.DASHBOARD_ORIGIN],
    telemetry: { enabled: false },
    logger: { disabled: true },
    emailAndPassword: {
      enabled: true,
      disableSignUp: true,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      password: {
        hash: hashPassword,
        verify: ({ hash, password }) => verifyPassword(hash, password),
      },
    },
    session: {
      expiresIn: 8 * 3600,
      disableSessionRefresh: true,
      cookieCache: { enabled: false },
      additionalFields: {
        mfaVerifiedAt: { type: "date", required: false, input: false },
        mfaMethod: { type: "string", required: false, input: false },
        lastSeenAt: { type: "date", required: false, input: false },
      },
    },
    user: {
      additionalFields: {
        disabled: { type: "boolean", defaultValue: false, input: false },
      },
    },
    advanced: {
      useSecureCookies: true,
      database: { generateId: () => randomUUID() },
      cookies: {
        session_token: {
          name: "__Host-getexception.session",
          attributes: {
            secure: true,
            httpOnly: true,
            sameSite: "strict",
            path: "/",
          },
        },
      },
    },
    databaseHooks: {
      session: {
        create: {
          before: async (session) => {
            const user = await db.user.findUnique({
              where: { id: session.userId },
              include: { members: { where: { active: true } } },
            });

            if (!user || user.disabled || !user.emailVerified) {
              return false;
            }

            const verified =
              session.mfaVerifiedAt instanceof Date &&
              ["totp", "recovery"].includes(String(session.mfaMethod));
            const enrollment =
              !user.twoFactorEnabled &&
              session.mfaMethod === "enrollment" &&
              !session.mfaVerifiedAt &&
              user.members.length > 0;

            if ((!user.twoFactorEnabled || !verified) && !enrollment) {
              return false;
            }

            return { data: { ...session, ipAddress: null, userAgent: null } };
          },
        },
      },
    },
    plugins: [
      organization({
        allowUserToCreateOrganization: false,
        requireEmailVerificationOnInvitation: false,
        teams: { enabled: true },
      }),
      twoFactor({ issuer: "GetException" }),
      ...extraPlugins,
    ],
  });
}
