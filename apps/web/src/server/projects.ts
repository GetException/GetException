import { ownerTransaction } from "./owner-transaction";
import { randomUUID } from "node:crypto";
import type { Transaction } from "@getexception/db";
import { projectInput } from "./project-input";
import { z } from "zod";
import { projectPurgeAt } from "../lib/project-lifecycle";
import { AuthError } from "./auth-error";
import { type AuthService } from "./auth-service";
import { digest, token } from "./crypto";

export async function createProject(
  service: AuthService,
  headers: Headers,
  input: unknown,
) {
  const data = projectInput.parse(input);
  const key = token();
  const id = randomUUID();

  await ownerTransaction(service, headers, async (tx, current) => {
    await checkSlug(tx, current.member.organizationId, data.slug);
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
        origins: { create: data.origins.map((origin) => ({ origin })) },
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

export async function updateProject(
  service: AuthService,
  headers: Headers,
  id: string,
  input: unknown,
) {
  const data = projectInput.parse(input);

  return ownerTransaction(service, headers, async (tx, current) => {
    const organizationId = current.member.organizationId;
    const project = await tx.project.findFirst({
      where: { id, organizationId, deletedAt: null },
    });

    if (!project) {
      throw new AuthError(404, "project_missing");
    }

    await checkSlug(tx, organizationId, data.slug, id);
    await tx.project.update({
      where: { id },
      data: {
        name: data.name,
        slug: data.slug,
        origins: {
          deleteMany: {},
          create: data.origins.map((origin) => ({ origin })),
        },
      },
    });
    await service.audit(tx, "project_update", true, current.user.id);

    return { id };
  });
}

export async function deleteProject(
  service: AuthService,
  headers: Headers,
  id: string,
  input: unknown,
) {
  const data = z
    .object({ slug: z.string().max(64) })
    .strict()
    .parse(input);

  return ownerTransaction(service, headers, async (tx, current) => {
    const project = await tx.project.findFirst({
      where: {
        id,
        organizationId: current.member.organizationId,
        deletedAt: null,
      },
    });

    if (!project) {
      throw new AuthError(404, "project_missing");
    }

    if (data.slug !== project.slug) {
      throw new AuthError(400, "project_confirmation");
    }

    const deletedAt = new Date();

    await tx.project.update({
      where: { id },
      data: { enabled: false, deletedAt },
    });
    await service.audit(tx, "project_delete", true, current.user.id);

    return { id, purgeAt: projectPurgeAt(deletedAt).toISOString() };
  });
}

export async function restoreProject(
  service: AuthService,
  headers: Headers,
  id: string,
  input: unknown,
) {
  z.object({}).strict().parse(input);

  return ownerTransaction(service, headers, async (tx, current) => {
    // Serialize restoration with the retention worker's first destructive batch.
    await tx.$queryRaw`SELECT id FROM project WHERE id = ${id} AND "organizationId" = ${current.member.organizationId} FOR UPDATE`;
    const project = await tx.project.findFirst({
      where: { id, organizationId: current.member.organizationId },
    });

    if (!project?.deletedAt) {
      throw new AuthError(404, "project_missing");
    }

    if (projectPurgeAt(project.deletedAt).getTime() <= Date.now()) {
      throw new AuthError(409, "project_expired");
    }

    await tx.project.update({
      where: { id },
      data: { enabled: true, deletedAt: null },
    });
    await service.audit(tx, "project_restore", true, current.user.id);

    return { id };
  });
}

async function checkSlug(
  tx: Transaction,
  organizationId: string,
  slug: string,
  exceptId?: string,
) {
  if (
    await tx.project.count({
      where: {
        organizationId,
        slug,
        ...(exceptId ? { id: { not: exceptId } } : {}),
      },
    })
  ) {
    throw new AuthError(409, "project_slug");
  }
}
