import { getRuntime } from "../../../../../../../server/runtime";
import { json, safeRoute, readBody } from "../../../../../../../server/http";
import { revokeSourceMapToken } from "../../../../../../../server/source-maps/tokens";

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string; tokenId: string }> },
) {
  return safeRoute(async () => {
    await readBody(request);
    const { id, tokenId } = await context.params;

    return json(
      await revokeSourceMapToken(
        getRuntime().service,
        request.headers,
        id,
        tokenId,
      ),
    );
  });
}
