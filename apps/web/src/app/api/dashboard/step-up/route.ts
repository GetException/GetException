import { getRuntime } from "../../../../server/runtime";
import { json, readBody, safeRoute } from "../../../../server/http";

export async function POST(request: Request) {
  return safeRoute(async () => {
    const data = await readBody(request);

    await getRuntime().service.stepUp(
      request.headers,
      data,
      request.headers.get("x-real-ip") ?? "unknown",
    );

    return json({ ok: true });
  });
}
