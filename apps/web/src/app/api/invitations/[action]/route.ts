import { cookies } from "next/headers";
import { getRuntime } from "../../../../server/runtime";
import { InvitationService } from "../../../../server/invitations/service";
import {
  REGISTRATION_COOKIE,
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
    const jar = await cookies();
    const registration = jar.get(REGISTRATION_COOKIE)?.value ?? "";

    if (["registration", "register", "accept-verified"].includes(action)) {
      if (action === "registration") {
        return json(await invitations.registrationDetails(registration));
      }

      const result =
        action === "register"
          ? await invitations.register(registration, input, ip)
          : await invitations.accept(request.headers, registration, true);

      jar.delete(REGISTRATION_COOKIE);

      return json(result);
    }

    const { token } = tokenInput.parse(input);

    if (action === "preview") {
      await service.rateLimit(ip, "invitation", "invitation_preview");

      return json(await invitations.preview(token));
    }

    if (action === "send-verification") {
      return json(await invitations.requestVerification(token, ip));
    }

    if (action === "verify-email") {
      jar.set(
        REGISTRATION_COOKIE,
        await invitations.verifyEmail(token, ip),
        cookieOptions,
      );

      return json({ ok: true });
    }

    if (action === "accept") {
      return json(await invitations.accept(request.headers, token));
    }

    return json({ error: "Not found" }, 404);
  });
}
