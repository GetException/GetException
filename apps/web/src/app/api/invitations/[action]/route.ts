import { cookies } from "next/headers";
import { getRuntime } from "../../../../server/runtime";
import { InvitationService } from "../../../../server/invitations/service";
import {
  beginRegistrationInput,
  codeInput,
  ENROLLMENT_COOKIE,
  ENROLLMENT_TTL,
  tokenInput,
} from "../../../../server/invitations/schemas";
import {
  cookieOptions,
  json,
  readBody,
  safeRoute,
} from "../../../../server/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  return safeRoute(async () => {
    const { action } = await context.params;
    const input = await readBody(request);
    const { service } = getRuntime();
    const invitations = new InvitationService(service);
    const ip = request.headers.get("x-real-ip") ?? "unknown";

    if (action === "begin-registration") {
      const { token, ...registration } = beginRegistrationInput.parse(input);
      const result = await invitations.beginRegistration(
        token,
        registration,
        ip,
      );
      const jar = await cookies();

      jar.set(ENROLLMENT_COOKIE, result.enrollmentToken, {
        ...cookieOptions,
        maxAge: ENROLLMENT_TTL / 1_000,
      });

      return json({
        secret: result.secret,
        uri: result.uri,
        expiresAt: result.expiresAt,
      });
    }

    if (action === "finish-registration") {
      const jar = await cookies();
      const enrollment = jar.get(ENROLLMENT_COOKIE)?.value ?? "";
      const { code } = codeInput.parse(input);
      const target = new URL(request.url);
      const headers = new Headers(request.headers);

      target.pathname = "/api/auth/invitation/finish-registration";
      headers.delete("content-length");

      return getRuntime().auth.handler(
        new Request(target, {
          method: "POST",
          headers,
          body: JSON.stringify({ code, enrollment }),
        }),
      );
    }

    const { token } = tokenInput.parse(input);

    if (action === "preview") {
      await service.rateLimit(ip, "invitation", "invitation_preview");

      return json(await invitations.preview(token));
    }

    if (action === "accept") {
      return json(await invitations.accept(request.headers, token));
    }

    return json({ error: "Not found" }, 404);
  });
}
