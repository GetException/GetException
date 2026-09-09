import { getRuntime } from "../../../../server/runtime";
import { createProject } from "../../../../server/projects";
import { json, readBody, safeRoute } from "../../../../server/http";

export async function POST(request: Request) {
  return safeRoute(async () => {
    const data = await readBody(request);

    return json(
      await createProject(getRuntime().service, request.headers, data),
      201,
    );
  });
}
