import { z } from "zod";
import { getRuntime } from "../../../../../../server/runtime";
import { json, readBody, safeRoute } from "../../../../../../server/http";
import { InvitationService } from "../../../../../../server/invitations/service";
import { saveMember, saveTeam } from "../../../../../../server/members";

export async function POST(
  request: Request,
  context: { params: Promise<{ resource: string; path?: string[] }> },
) {
  return safeRoute(async () => {
    const { resource, path = [] } = await context.params;
    const input = await readBody(request);
    const { service } = getRuntime();
    const [id, action] = path;

    if (id) {
      z.string().uuid().parse(id);
    }

    if (resource === "invitations") {
      const invitations = new InvitationService(service);

      if (!path.length) {
        return json(await invitations.create(request.headers, input));
      }

      if (
        id &&
        path.length === 2 &&
        (action === "resend" || action === "revoke")
      ) {
        return json(await invitations.change(request.headers, id, action));
      }
    }

    if (resource === "teams" && path.length <= 1) {
      return json(await saveTeam(service, request.headers, id, input));
    }

    if (resource === "members" && id && path.length === 1) {
      return json(await saveMember(service, request.headers, id, input));
    }

    return json({ error: "Not found" }, 404);
  });
}
