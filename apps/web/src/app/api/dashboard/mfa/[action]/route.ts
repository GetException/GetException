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
    const ip = request.headers.get("x-real-ip") ?? "unknown";

    if (action === "prepare") {
      return json(await service.prepare(request.headers, data, ip));
    }

    if (action === "finish") {
      return json(await service.finish(request.headers, data, ip));
    }

    if (action === "disable") {
      return json(await service.disable(request.headers, data, ip));
    }

    return json({ error: "Not found" }, 404);
  });
}
