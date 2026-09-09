import { getRuntime } from "../../../../server/runtime";
import {
  checkMutation,
  json,
  readBody,
  safeRoute,
} from "../../../../server/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ path: string[] }> },
) {
  return safeRoute(async () => {
    const path = (await context.params).path.join("/");

    // Do not expose built-in signup, invitation, trusted-device or email OTP routes.
    if (!["login", "owner/login", "sign-out"].includes(path)) {
      return json({ error: "Not found" }, 404);
    }

    checkMutation(request);
    const input = await readBody(request);
    const target = new URL(request.url);

    if (path === "login") {
      target.pathname = "/api/auth/owner/login";
    }

    const forwarded = new Request(target, {
      method: "POST",
      headers: request.headers,
      body: JSON.stringify(input),
    });
    const response = await getRuntime().auth.handler(forwarded);

    response.headers.set("Cache-Control", "no-store");
    response.headers.set("X-Content-Type-Options", "nosniff");

    return response;
  });
}
