import { ownerTransaction } from "./owner-transaction";
import { randomUUID } from "node:crypto";
import { z } from "zod";
import { canonicalOrigin } from "@getexception/config";
import { AuthError } from "./auth-error";
import { type AuthService } from "./auth-service";
import { digest, token } from "./crypto";

export async function createProject(
  service: AuthService,
  headers: Headers,
  input: unknown,
) {
  const data = z
    .object({
      name: z.string().trim().min(1).max(80),
      slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
      origins: z.array(z.string().max(300)).min(1).max(20),
    })
    .strict()
    .parse(input);
  const origins = [
    ...new Set(
      data.origins.map((value) =>
        canonicalOrigin(
          value,
          new URL(service.config.DASHBOARD_ORIGIN).hostname.endsWith(
            ".localhost",
          ),
        ),
      ),
    ),
  ];
  const key = token();
  const id = randomUUID();

  await ownerTransaction(service, headers, async (tx, current) => {
    const team = await tx.team.findFirst({
      where: { organizationId: current.member.organizationId },
      orderBy: { createdAt: "asc" },
    });

    if (!team) {
      throw new AuthError();
    }

    await tx.project.create({
      data: {
        id,
        name: data.name,
        slug: data.slug,
        organizationId: current.member.organizationId,
        origins: { create: origins.map((origin) => ({ origin })) },
        keys: { create: { keyHash: digest(key) } },
        teams: { create: { teamId: team.id } },
      },
    });
    await service.audit(tx, "project_create", true, current.user.id);
  });
  const url = new URL(service.config.INGEST_ORIGIN);

  url.username = key;
  url.pathname = `/${id}`;

  return { id, dsn: url.toString() };
}
