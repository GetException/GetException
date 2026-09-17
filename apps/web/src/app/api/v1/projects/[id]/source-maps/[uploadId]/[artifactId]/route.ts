import { getRuntime } from "../../../../../../../../server/runtime";
import { json, safeRoute } from "../../../../../../../../server/http";
import {
  uploadArtifact,
  checkUploadRequest,
} from "../../../../../../../../server/source-maps/upload";

export async function PUT(
  request: Request,
  context: {
    params: Promise<{ id: string; uploadId: string; artifactId: string }>;
  },
) {
  return safeRoute(async () => {
    checkUploadRequest(request);
    const { id, uploadId, artifactId } = await context.params;

    return json(
      await uploadArtifact(
        getRuntime().service,
        request,
        id,
        uploadId,
        artifactId,
      ),
    );
  });
}
