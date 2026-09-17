import { getRuntime } from "../../../../../../server/runtime";
import { json, safeRoute, readBody } from "../../../../../../server/http";
import { createSourceMapToken } from "../../../../../../server/source-maps/tokens";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return safeRoute(async () => {
    const body = await readBody(request);
    const { id } = await context.params;

    return json(
      await createSourceMapToken(
        getRuntime().service,
        request.headers,
        id,
        body,
      ),
      201,
    );
  });
}
