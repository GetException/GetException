import { getRuntime } from "../../../../../../server/runtime";
import { restoreProject } from "../../../../../../server/projects";
import { json, readBody, safeRoute } from "../../../../../../server/http";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return safeRoute(async () => {
    const data = await readBody(request);
    const { id } = await context.params;

    return json(
      await restoreProject(getRuntime().service, request.headers, id, data),
    );
  });
}
