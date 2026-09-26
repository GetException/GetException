import { getRuntime } from "../../../../../server/runtime";
import { json, readBody, safeRoute } from "../../../../../server/http";
import { MfaService } from "../../../../../server/mfa";

export async function POST(
  request: Request,
  context: { params: Promise<{ action: string }> },
) {
  return safeRoute(async () => {
    const { action } = await context.params;
    const data = await readBody(request);
    const service = new MfaService(getRuntime().service);

    if (action === "details") {
      return json(await service.details(request.headers));
    }

    if (action === "finish") {
      return json(
        await service.finish(
          request.headers,
          data,
          request.headers.get("x-real-ip") ?? "unknown",
        ),
      );
    }

    return json({ error: "Not found" }, 404);
  });
}
