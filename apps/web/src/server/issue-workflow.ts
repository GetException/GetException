import { canResolve, projectScope } from "./access";
import { z } from "zod";
import { AuthError } from "./auth-error";
import { type AuthService } from "./auth-service";

export async function changeIssueStatus(
  service: AuthService,
  headers: Headers,
  id: string,
  input: unknown,
) {
  const { member, user, session } = await service.authorize(headers);

  if (!canResolve(member)) {
    throw new AuthError(403);
  }

  const data = z
    .object({
      status: z.enum(["open", "resolved"]),
      eventCount: z.number().int().min(0).max(2147483647),
    })
    .strict()
    .parse(input);

  return service.db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM workspace WHERE id = ${member.organizationId} FOR SHARE`;
    const fresh = await tx.member.findUnique({ where: { id: member.id } });

    if (
      !fresh?.active ||
      !canResolve(fresh) ||
      !(await tx.session.findUnique({ where: { id: session.id } }))
    ) {
      throw new AuthError(403);
    }

    const where = { id, project: projectScope(member) };
    const issue = await tx.issue.findFirst({
      where,
      select: { status: true, eventCount: true },
    });

    if (!issue) {
      throw new AuthError(404);
    }

    if (issue.eventCount !== data.eventCount) {
      throw new AuthError(409);
    }

    if (issue.status === data.status) {
      return { status: data.status };
    }

    const result = await tx.issue.updateMany({
      where: { ...where, eventCount: data.eventCount, status: issue.status },
      data: { status: data.status, regression: false },
    });

    if (result.count !== 1) {
      throw new AuthError(409);
    }

    if (issue.status !== data.status) {
      await service.audit(
        tx,
        data.status === "resolved" ? "issue_resolve" : "issue_reopen",
        true,
        user.id,
      );
    }

    return { status: data.status };
  });
}
