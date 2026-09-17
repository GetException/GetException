import type {
  BuildContext,
  ReleaseDeploymentInput,
} from "@getexception/protocol";
import type { AuthService } from "../auth-service";
import { AuthError } from "../auth-error";
import { digest } from "../crypto";
import { authorizeGitlab } from "./gitlab";

export type UploadPrincipal =
  { kind: "token" } | { kind: "gitlab"; context: BuildContext };

export async function authorizeUpload(
  service: AuthService,
  headers: Headers,
  projectId: string,
): Promise<UploadPrincipal> {
  if (headers.has("origin")) {
    throw new AuthError(403);
  }

  const authorization = headers.get("authorization") ?? "";
  const identity =
    /^GitLab ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
      authorization,
    );

  if (identity) {
    try {
      return {
        kind: "gitlab",
        context: await authorizeGitlab(service, identity[1]!, projectId),
      };
    } catch {
      await service.rateLimit(
        headers.get("x-real-ip") ?? "unknown",
        projectId,
        "source_map_auth",
      );

      throw new AuthError(401);
    }
  }

  const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);

  if (!match) {
    throw new AuthError(401);
  }

  const credential = await service.db.sourceMapToken.findFirst({
    where: {
      projectId,
      tokenHash: digest(match[1]!),
      revokedAt: null,
      expiresAt: { gt: new Date() },
      project: { enabled: true, deletedAt: null },
    },
  });

  if (!credential) {
    await service.rateLimit(
      headers.get("x-real-ip") ?? "unknown",
      projectId,
      "source_map_auth",
    );

    throw new AuthError(401);
  }

  return { kind: "token" };
}

export function assertUploadScope(
  principal: UploadPrincipal,
  release: string,
  artifacts: { path: string }[],
) {
  if (
    principal.kind === "gitlab" &&
    (release !== principal.context.release ||
      !artifacts.length ||
      artifacts.some(
        (file) => !file.path.startsWith(principal.context.assetPrefix),
      ))
  ) {
    throw new AuthError(403);
  }
}

export function assertReleaseScope(
  principal: UploadPrincipal,
  release: string,
  deployment: ReleaseDeploymentInput,
) {
  if (principal.kind === "gitlab") {
    const expected = principal.context;

    if (
      release !== expected.release ||
      deployment.environment !== expected.deployment.environment ||
      deployment.review?.repositoryId !==
        expected.deployment.review?.repositoryId ||
      deployment.review?.number !== expected.deployment.review?.number
    ) {
      throw new AuthError(403);
    }
  }
}
