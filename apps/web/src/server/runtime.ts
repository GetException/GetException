import { createDatabase } from "@getexception/db";
import { webConfig } from "@getexception/config";
import { createAuthEndpoint, APIError } from "better-auth/api";
import { setSessionCookie } from "better-auth/cookies";
import { AuthError } from "./auth-error";
import { AuthService } from "./auth-service";
import { loginSchema } from "./auth-schemas";
import { createIdentity } from "./identity";

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

              return ctx.json({ ok: true });
            } catch (error) {
              throw new APIError(
                error instanceof AuthError && error.status === 429
                  ? "TOO_MANY_REQUESTS"
                  : "UNAUTHORIZED",
                { message: "Unable to sign in" },
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
