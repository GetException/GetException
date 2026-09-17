import { getRuntime } from "../../../../../../../server/runtime";
import { json, safeRoute } from "../../../../../../../server/http";
import {
  finishUpload,
  uploadStatus,
  checkUploadRequest,
} from "../../../../../../../server/source-maps/upload";

type Context = { params: Promise<{ id: string; uploadId: string }> };

export async function POST(request: Request, context: Context) {
  return safeRoute(async () => {
    checkUploadRequest(request);
    const { id, uploadId } = await context.params;

    return json(
      await finishUpload(getRuntime().service, request.headers, id, uploadId),
      202,
    );
  });
}

export async function GET(request: Request, context: Context) {
  return safeRoute(async () => {
    checkUploadRequest(request);
    const { id, uploadId } = await context.params;

    return json(
      await uploadStatus(getRuntime().service, request.headers, id, uploadId),
    );
  });
}
