import { releaseRegistrationSchema } from "@getexception/protocol";
import type { AuthService } from "../auth-service";
import { AuthError } from "../auth-error";
import {
  authorizeUpload,
  assertReleaseScope,
} from "../source-maps/authorization";

export async function registerRelease(
  service: AuthService,
  headers: Headers,
  projectId: string,
  value: unknown,
) {
  const principal = await authorizeUpload(
    service,
    headers,
    projectId,
    "release",
  );
  const input = releaseRegistrationSchema.parse(value);

  assertReleaseScope(principal, input.release, input.deployment);
  const review = input.deployment.review;
  const reviewKey = review
    ? `gitlab:${review.repositoryId}:${review.number}`
    : "";

  await service.rateLimit(
    headers.get("x-real-ip") ?? "unknown",
    projectId,
    "release_registration",
  );

  return service.db.$transaction(async (tx) => {
    const project = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM project WHERE id = ${projectId} AND enabled AND "deletedAt" IS NULL FOR UPDATE`;

    if (!project.length) {
      throw new AuthError(404);
    }

    const release = await tx.release.upsert({
      where: { projectId_name: { projectId, name: input.release } },
      create: { projectId, name: input.release },
      update: {},
    });

    await tx.releaseDeployment.upsert({
      where: {
        releaseId_environment_reviewKey: {
          releaseId: release.id,
          environment: input.deployment.environment,
          reviewKey,
        },
      },
      create: {
        releaseId: release.id,
        environment: input.deployment.environment,
        reviewKey,
        registeredAt: new Date(),
      },
      update: { registeredAt: new Date() },
    });

    return { id: release.id };
  });
}
