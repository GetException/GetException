import { z } from "zod";
import { ownerTransaction } from "../owner-transaction";
import type { AuthService } from "../auth-service";
import { AuthError } from "../auth-error";
import { digest, token } from "../crypto";

export async function createSourceMapToken(
  service: AuthService,
  headers: Headers,
  projectId: string,
  input: unknown,
) {
  const data = z
    .object({ name: z.string().trim().min(1).max(80) })
    .strict()
    .parse(input);
  const secret = token();

  return ownerTransaction(service, headers, async (tx, current) => {
    const project = await tx.project.findFirst({
      where: {
        id: projectId,
        organizationId: current.member.organizationId,
        deletedAt: null,
      },
    });

    if (!project) {
      throw new AuthError(404);
    }

    if (
      (await tx.sourceMapToken.count({
        where: { projectId, revokedAt: null, expiresAt: { gt: new Date() } },
      })) >= 10
    ) {
      throw new AuthError(409);
    }

    const created = await tx.sourceMapToken.create({
      data: {
        projectId,
        name: data.name,
        tokenHash: digest(secret),
        expiresAt: new Date(Date.now() + 90 * 86400_000),
      },
    });

    await service.audit(tx, "source_map_token_create", true, current.user.id);

    return {
      id: created.id,
      token: secret,
      expiresAt: created.expiresAt.toISOString(),
    };
  });
}

export async function revokeSourceMapToken(
  service: AuthService,
  headers: Headers,
  projectId: string,
  tokenId: string,
) {
  return ownerTransaction(service, headers, async (tx, current) => {
    const result = await tx.sourceMapToken.updateMany({
      where: {
        id: tokenId,
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

    await service.audit(tx, "source_map_token_revoke", true, current.user.id);

    return { ok: true };
  });
}
