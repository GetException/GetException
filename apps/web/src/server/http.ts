import { boundedJson } from "@getexception/protocol";
import { AuthError } from "./auth-error";
import { getRuntime } from "./runtime";

export const SETUP_COOKIE = "__Host-getexception.setup";

export const cookieOptions = {
  httpOnly: true,
  secure: true,
  sameSite: "strict" as const,
  path: "/",
  maxAge: 900,
};

export function json(value: unknown, status = 200) {
  return Response.json(value, {
    status,
    headers: {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      "Referrer-Policy": "no-referrer",
    },
  });
}

export function checkMutation(request: Request) {
  if (
    request.headers.get("origin") !== getRuntime().config.DASHBOARD_ORIGIN ||
    request.headers.get("content-type")?.split(";")[0] !== "application/json"
  ) {
    throw new AuthError();
  }
}

export async function readBody(request: Request) {
  checkMutation(request);

  if (Number(request.headers.get("content-length") ?? 0) > 16_384) {
    throw new AuthError(413);
  }

  const reader = request.body?.getReader();

  if (!reader) {
    throw new AuthError(400);
  }

  const chunks: Uint8Array[] = [];
  let size = 0;

  for (;;) {
    const { done, value } = await reader.read();

    if (done) {
      break;
    }

    size += value.length;

    if (size > 16_384) {
      await reader.cancel();

      throw new AuthError(413);
    }

    chunks.push(value);
  }

  const bytes = new Uint8Array(size);
  let offset = 0;

  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.length;
  }

  return boundedJson(
    new TextDecoder("utf-8", { fatal: true }).decode(bytes),
    16_384,
  );
}

export async function safeRoute(fn: () => Promise<Response>) {
  try {
    return await fn();
  } catch (error) {
    const status =
      error instanceof AuthError
        ? error.status
        : error instanceof Error &&
            (error.name === "ZodError" ||
              error.message === "invalid" ||
              error.message === "too_large")
          ? 400
          : 503;

    const reasons: Record<string, string> = {
      member_exists:
        "This email already belongs to a member. Edit their access in Members.",
      invitation_pending:
        "An invitation is already pending for this email. Resend or revoke it in Members.",
      invitation_email:
        "Sign in with the email address this invitation was sent to.",
      last_owner: "The workspace must keep at least one active Owner.",
      owner_mfa:
        "This member must enable an authenticator in Settings before becoming an Owner.",
      project_team: "Every project must belong to at least one team.",
    };

    return json(
      {
        error:
          error instanceof AuthError &&
          error.reason &&
          Object.hasOwn(reasons, error.reason)
            ? reasons[error.reason]
            : status === 410
              ? "This link has expired or was already used. Ask your Owner for a new invitation."
              : status === 428
                ? "Confirm your password and a new authenticator code."
                : "Unable to complete this request.",
      },
      status,
    );
  }
}
