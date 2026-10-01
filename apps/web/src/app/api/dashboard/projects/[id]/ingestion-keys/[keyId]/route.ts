import { getRuntime } from "../../../../../../../server/runtime";
import { json, safeRoute, readBody } from "../../../../../../../server/http";
import { revokeIngestionKey } from "../../../../../../../server/ingestion-keys";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; keyId: string }> },
) {
  return safeRoute(async () => {
    await readBody(request);
    const { id, keyId } = await context.params;

    return json(
      await revokeIngestionKey(
        getRuntime().service,
        request.headers,
        id,
        keyId,
      ),
    );
  });
}
