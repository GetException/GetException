import { getRuntime } from "../../../../../../server/runtime";
import { json, safeRoute } from "../../../../../../server/http";
import {
  authorizeUpload,
  checkUploadRequest,
  readUploadManifest,
} from "../../../../../../server/source-maps/upload";
import { registerRelease } from "../../../../../../server/releases/register";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return safeRoute(async () => {
    checkUploadRequest(request);
    const { id } = await context.params;
    const { service } = getRuntime();

    await authorizeUpload(service, request.headers, id);

    return json(
      await registerRelease(
        service,
        request.headers,
        id,
        await readUploadManifest(request),
      ),
      201,
    );
  });
}
