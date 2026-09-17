import { getRuntime } from "../../../../../../server/runtime";
import { json, safeRoute } from "../../../../../../server/http";
import {
  authorizeUpload,
  beginUpload,
  checkUploadRequest,
  readUploadManifest,
} from "../../../../../../server/source-maps/upload";

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
      await beginUpload(
        service,
        request.headers,
        id,
        await readUploadManifest(request),
      ),
      201,
    );
  });
}
