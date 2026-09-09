import { cookies } from "next/headers";
import { z } from "zod";
import { getRuntime } from "../../../../server/runtime";
import {
  cookieOptions,
  json,
  readBody,
  safeRoute,
  SETUP_COOKIE,
} from "../../../../server/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  return safeRoute(async () => {
    const { action } = await context.params;
    const input = await readBody(request);
    const jar = await cookies();
    const { service } = getRuntime();
    const ip = request.headers.get("x-real-ip") ?? "unknown";

    if (action === "access") {
      const data = z
        .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
        .strict()
        .parse(input);

      jar.set(
        SETUP_COOKIE,
        await service.setupAccess(data.token, ip),
        cookieOptions,
      );

      return json({ ok: true });
    }

    const access = jar.get(SETUP_COOKIE)?.value ?? "";

    if (action === "prepare") {
      return json(await service.prepareSetup(access, input, ip));
    }

    if (action === "finish") {
      const data = z
        .object({
          code: z.string().regex(/^\d{6}$/),
          trustDevice: z.literal(false),
        })
        .strict()
        .parse(input);
      const result = await service.finishSetup(access, data.code, ip);

      jar.delete(SETUP_COOKIE);

      return json(result);
    }

    return json({ error: "Not found" }, 404);
  });
}
