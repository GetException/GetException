import { z } from "zod";
import type { AuthService } from "./auth-service";
import { AuthError } from "./auth-error";
import { ownerTransaction } from "./owner-transaction";
import { digest, token } from "./crypto";

export async function rotateIngestionKey(
  service: AuthService,
  headers: Headers,
  projectId: string,
  input: unknown,
) {
  const { revokeImmediately } = z
    .object({ revokeImmediately: z.boolean() })
    .strict()
    .parse(input);

  return ownerTransaction(service, headers, async (tx, current) => {
    const project = await tx.project.findFirst({
      where: {
        id: projectId,
        organizationId: current.member.organizationId,
        deletedAt: null,
      },
    });

    if (!project) {
      throw new AuthError(404, "project_missing");
    }

    const now = new Date();
    const expiresAt = new Date(now.getTime() + 86400_000);

    if (revokeImmediately) {
      await tx.projectIngestionKey.updateMany({
        where: { projectId, revokedAt: null },
        data: { revokedAt: now },
      });
    } else {
      if (
        (await tx.projectIngestionKey.count({
          where: {
            projectId,
            revokedAt: null,
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
        })) >= 10
      ) {
        throw new AuthError(409, "ingestion_key_limit");
      }

      await tx.projectIngestionKey.updateMany({
        where: {
          projectId,
          revokedAt: null,
          OR: [{ expiresAt: null }, { expiresAt: { gt: expiresAt } }],
        },
        data: { expiresAt },
      });
    }

    const secret = token();
    const key = await tx.projectIngestionKey.create({
      data: { projectId, keyHash: digest(secret) },
    });

    await service.audit(tx, "ingestion_key_rotate", true, current.user.id);
    const dsn = new URL(service.config.INGEST_ORIGIN);

    dsn.username = secret;
    dsn.pathname = `/${projectId}`;

    return { id: key.id, dsn: dsn.toString() };
  });
}

export async function revokeIngestionKey(
  service: AuthService,
  headers: Headers,
  projectId: string,
  keyId: string,
) {
  return ownerTransaction(service, headers, async (tx, current) => {
    const result = await tx.projectIngestionKey.updateMany({
      where: {
        id: keyId,
        projectId,
        project: {
          organizationId: current.member.organizationId,
          deletedAt: null,
        },
      },
      data: { revokedAt: new Date() },
    });

    if (!result.count) {
      throw new AuthError(404);
    }

    await service.audit(tx, "ingestion_key_revoke", true, current.user.id);

    return { ok: true };
  });
}
