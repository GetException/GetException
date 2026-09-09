import { getRuntime } from "../../../../server/runtime";
import { json, safeRoute } from "../../../../server/http";

export async function GET(request: Request) {
  return safeRoute(async () => {
    const { session } = await getRuntime().service.authorize(request.headers);

    return json({ active: true, mfaVerifiedAt: session.mfaVerifiedAt });
  });
}
