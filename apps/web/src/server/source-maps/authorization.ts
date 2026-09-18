import type {
  BuildContext,
  ReleaseDeploymentInput,
} from "@getexception/protocol";
import type { AuthService } from "../auth-service";
import { AuthError } from "../auth-error";
import { digest } from "../crypto";
import { authorizeGitlab, resolveGitlabContext } from "./gitlab";
import { gitlabBinding } from "./policy";
import { CiAuthError } from "./ci-error";

export type UploadPrincipal =
  { kind: "token" } | { kind: "gitlab"; context: BuildContext };

function gitlabIdentity(headers: Headers) {
  if (headers.has("origin")) {
    throw new CiAuthError("CI_ORIGIN_FORBIDDEN", 403);
  }

  return /^GitLab ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(
    headers.get("authorization") ?? "",
  )?.[1];
}

export async function authorizeCiContext(
  service: AuthService,
  headers: Headers,
  projectId: string,
) {
  const jwt = gitlabIdentity(headers);

  try {
    if (!jwt) {
      throw new CiAuthError(
        headers.has("authorization") ? "CI_TOKEN_INVALID" : "CI_TOKEN_MISSING",
      );
    }

    return await resolveGitlabContext(service, jwt, projectId);
  } catch (error) {
    return rejectCiRequest(service, headers, projectId, error);
  }
}

async function rejectCiRequest(
  service: AuthService,
  headers: Headers,
  projectId: string,
  error: unknown,
): Promise<never> {
  if (error instanceof CiAuthError && error.status >= 500) {
    throw error;
  }

  try {
    await service.rateLimit(
      headers.get("x-real-ip") ?? "unknown",
      projectId,
      "source_map_auth",
    );
  } catch (limited) {
    throw limited instanceof AuthError && limited.status === 429
      ? new CiAuthError("CI_RATE_LIMITED", 429)
      : new CiAuthError("CI_SERVER_ERROR", 503);
  }

  throw error instanceof CiAuthError
    ? error
    : new CiAuthError("CI_TOKEN_INVALID");
}

export async function authorizeUpload(
  service: AuthService,
  headers: Headers,
  projectId: string,
  operation: "maps" | "release" = "maps",
): Promise<UploadPrincipal> {
  if (headers.has("origin")) {
    throw new AuthError(403);
  }

  const authorization = headers.get("authorization") ?? "";
  const identity = gitlabIdentity(headers);

  if (identity) {
    try {
      return {
        kind: "gitlab",
        context: await authorizeGitlab(service, identity, projectId, operation),
      };
    } catch (error) {
      if (error instanceof AuthError && error.status === 403) {
        throw error;
      }

      return rejectCiRequest(service, headers, projectId, error);
    }
  }

  const match = /^Bearer ([a-f0-9]{64})$/.exec(authorization);

  if (!match) {
    throw new AuthError(401);
  }

  // A permanent token cannot prove its environment and must not bypass the CI policy.
  if (gitlabBinding(service, projectId)) {
    throw new AuthError(403);
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
