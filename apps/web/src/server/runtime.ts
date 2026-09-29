import { createDatabase } from "@getexception/db";
import { webConfig } from "@getexception/config";
import { createAuthEndpoint, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { AuthError } from "./auth-error";
import { AuthService } from "./auth-service";
import { loginSchema } from "./auth-schemas";
import { createIdentity } from "./identity";
import { InvitationService } from "./invitations/service";
import {
  ENROLLMENT_COOKIE,
  finishRegistrationInput,
} from "./invitations/schemas";

export function createRuntime(
  config = webConfig(),
  db = createDatabase(config.DATABASE_URL),
) {
  const service = new AuthService(db, config);
  const auth = createIdentity(db, config, [
    {
      id: "getexception-members",
      endpoints: {
        ownerLogin: createAuthEndpoint(
          "/owner/login",
          { method: "POST", body: loginSchema },
          async (ctx) => {
            try {
              const result = await service.login(
                ctx.body,
                ctx.headers?.get("x-real-ip") ?? "unknown",
              );

              await setSessionCookie(ctx, result, false);
              ctx.setHeader("Cache-Control", "no-store");

              return ctx.json({
                ok: true,
                enrollmentRequired: result.enrollmentRequired,
              });
            } catch (error) {
              throw new APIError(
                error instanceof AuthError && error.status === 429
                  ? "TOO_MANY_REQUESTS"
                  : "UNAUTHORIZED",
                {
                  message:
                    "Email, password or authenticator code is incorrect. If you just used this code, wait for a new one.",
                },
              );
            }
          },
        ),
        finishInvitationRegistration: createAuthEndpoint(
          "/invitation/finish-registration",
          { method: "POST", body: finishRegistrationInput },
          async (ctx) => {
            try {
              const invitations = new InvitationService(service);
              const result = await invitations.finishRegistration(
                ctx.body.enrollment,
                { code: ctx.body.code },
                ctx.headers?.get("x-real-ip") ?? "unknown",
              );

              await setSessionCookie(ctx, result, false);
              ctx.setCookie(ENROLLMENT_COOKIE, "", {
                httpOnly: true,
                secure: true,
                sameSite: "strict",
                path: "/",
                maxAge: 0,
              });
              ctx.setHeader("Cache-Control", "no-store");

              return ctx.json({ recoveryCodes: result.recoveryCodes });
            } catch (error) {
              throw new APIError(
                error instanceof AuthError && error.status === 429
                  ? "TOO_MANY_REQUESTS"
                  : "UNAUTHORIZED",
                {
                  message:
                    "Unable to finish registration. Check the current authenticator code and try again.",
                },
              );
            }
          },
        ),
      },
    },
  ]);

  return { config, db, service, auth };
}

let runtime: ReturnType<typeof createRuntime> | undefined;

export function getRuntime() {
  return (runtime ??= createRuntime());
}
