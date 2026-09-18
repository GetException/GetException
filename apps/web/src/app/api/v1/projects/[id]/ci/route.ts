import { getRuntime } from "../../../../../../server/runtime";
import { json, safeRoute } from "../../../../../../server/http";
import { authorizeCiContext } from "../../../../../../server/source-maps/authorization";
import { checkUploadRequest } from "../../../../../../server/source-maps/upload";
import { AuthError } from "../../../../../../server/auth-error";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return safeRoute(async () => {
    checkUploadRequest(request);
    const version = new URL(request.url).searchParams.get("version");

    if (version !== null && version !== "2") {
      throw new AuthError(400);
    }

    const { id } = await context.params;
    const result = await authorizeCiContext(
      getRuntime().service,
      request.headers,
      id,
    );

    if (version === "2") {
      return json(result);
    }

    // Old CLI versions cannot represent a policy skip. Never turn one into permission.
    if (!("release" in result) || !result.sourceMaps.enabled) {
      throw new AuthError(403);
    }

    return json({
      release: result.release,
      assetPrefix: result.assetPrefix,
      deployment: result.deployment,
    });
  });
}
