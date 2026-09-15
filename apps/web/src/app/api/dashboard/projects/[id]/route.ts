import { getRuntime } from "../../../../../server/runtime";
import { updateProject, deleteProject } from "../../../../../server/projects";
import { json, readBody, safeRoute } from "../../../../../server/http";

export async function PATCH(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return safeRoute(async () => {
    const data = await readBody(request);
    const { id } = await context.params;

    return json(
      await updateProject(getRuntime().service, request.headers, id, data),
    );
  });
}

export async function DELETE(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return safeRoute(async () => {
    const data = await readBody(request);
    const { id } = await context.params;

    return json(
      await deleteProject(getRuntime().service, request.headers, id, data),
    );
  });
}
