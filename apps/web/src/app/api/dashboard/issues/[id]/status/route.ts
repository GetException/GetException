import { getRuntime } from "../../../../../../server/runtime";
import { json, readBody, safeRoute } from "../../../../../../server/http";
import { changeIssueStatus } from "../../../../../../server/issue-workflow";

export async function POST(
  request: Request,
  context: { params: Promise<{ id: string }> },
) {
  return safeRoute(async () =>
    json(
      await changeIssueStatus(
        getRuntime().service,
        request.headers,
        (await context.params).id,
        await readBody(request),
      ),
    ),
  );
}
