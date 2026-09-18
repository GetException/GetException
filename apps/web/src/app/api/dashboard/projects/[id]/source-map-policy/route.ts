import { getRuntime } from "../../../../../../server/runtime";
import { json, readBody, safeRoute } from "../../../../../../server/http";
import { updateSourceMapPolicy } from "../../../../../../server/source-maps/policy";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return safeRoute(async () => {
    const data = await readBody(request);
    const { id } = await context.params;

    return json(
      await updateSourceMapPolicy(
        getRuntime().service,
        request.headers,
        id,
        data,
      ),
    );
  });
}
