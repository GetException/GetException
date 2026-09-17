import { getRuntime } from "../../../../../../server/runtime";
import { json, safeRoute } from "../../../../../../server/http";
import { authorizeUpload } from "../../../../../../server/source-maps/authorization";
import { checkUploadRequest } from "../../../../../../server/source-maps/upload";
import { AuthError } from "../../../../../../server/auth-error";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return safeRoute(async () => {
    checkUploadRequest(request);
    const { id } = await context.params;
    const principal = await authorizeUpload(
      getRuntime().service,
      request.headers,
      id,
    );

    if (principal.kind !== "gitlab") {
      throw new AuthError(403);
    }

    return json(principal.context);
  });
}
