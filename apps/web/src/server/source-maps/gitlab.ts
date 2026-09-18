import { createLocalJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { parseGitlabTrust } from "@getexception/config";
import {
  buildContextSchema,
  ciContextSchema,
  type BuildContext,
  type CiContext,
} from "@getexception/protocol";
import type { AuthService } from "../auth-service";
import { AuthError } from "../auth-error";
import { effectiveSourceMapPolicy, gitlabBinding } from "./policy";

const identifier = z
  .union([
    z.string().regex(/^[1-9][0-9]{0,14}$/),
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform(String);
const claimsSchema = z.object({
  project_id: identifier,
  project_path: z
    .string()
    .max(255)
    .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/),
  job_project_id: identifier.optional(),
  job_project_path: z.string().optional(),
  job_id: identifier,
  pipeline_id: identifier,
  pipeline_source: z.enum(["merge_request_event", "push", "web"]),
  sha: z.string().regex(/^[a-f0-9]{40}$/),
  ref: z.string().min(1).max(255),
  ref_type: z.enum(["branch", "tag"]),
  ref_path: z.string().min(1).max(270),
  ref_protected: z.union([z.boolean(), z.enum(["true", "false"])]),
  environment: z.string().min(1).max(255),
  ci_config_ref_uri: z.string().max(1024).nullable(),
  ci_config_sha: z
    .string()
    .regex(/^[a-f0-9]{40}$/)
    .nullable(),
});
const verifiers = new WeakMap<
  AuthService,
  {
    raw: string;
    trust: ReturnType<typeof parseGitlabTrust>;
    keys: ReturnType<typeof createLocalJWKSet>;
  }
>();

export async function authorizeGitlab(
  service: AuthService,
  jwt: string,
  projectId: string,
  operation: "maps" | "release" = "maps",
): Promise<BuildContext> {
  const context = await resolveGitlabContext(service, jwt, projectId);

  if (
    !("release" in context) ||
    (operation === "maps" && !context.sourceMaps.enabled)
  ) {
    throw new AuthError(403);
  }

  return buildContextSchema.parse({
    release: context.release,
    assetPrefix: context.assetPrefix,
    deployment: context.deployment,
  });
}

export async function resolveGitlabContext(
  service: AuthService,
  jwt: string,
  projectId: string,
): Promise<CiContext> {
  try {
    const raw = service.config.GITLAB_CI_TRUST;

    if (!raw || jwt.length > 16384) {
      throw new Error("Unconfigured build identity");
    }

    let verifier = verifiers.get(service);

    if (!verifier || verifier.raw !== raw) {
      const trust = parseGitlabTrust(raw);

      verifier = { raw, trust, keys: createLocalJWKSet(trust.jwks) };
      verifiers.set(service, verifier);
    }

    const { trust, keys } = verifier;
    const binding = trust.projects.find(
      (entry) => entry.projectId === projectId,
    );

    if (!binding) {
      throw new Error("Unknown build project");
    }

    const { payload, protectedHeader } = await jwtVerify(jwt, keys, {
      algorithms: ["RS256"],
      issuer: trust.issuer,
      audience: service.config.DASHBOARD_ORIGIN,
      requiredClaims: ["exp", "iat", "nbf", "jti", "sub"],
      maxTokenAge: 3600,
    });

    if (
      payload.aud !== service.config.DASHBOARD_ORIGIN ||
      !payload.exp ||
      !payload.iat ||
      payload.exp - payload.iat > 3600 ||
      payload.exp <= payload.iat ||
      !payload.jti ||
      payload.jti.length > 256 ||
      !protectedHeader.kid ||
      (protectedHeader.typ !== undefined && protectedHeader.typ !== "JWT") ||
      Object.keys(protectedHeader).some(
        (name) => !["alg", "kid", "typ"].includes(name),
      )
    ) {
      throw new Error("Invalid build identity");
    }

    const claims = claimsSchema.parse(payload);
    const expectedRef = `refs/${claims.ref_type === "branch" ? "heads" : "tags"}/${claims.ref}`;
    const configRef = `${new URL(trust.issuer).host}/${claims.project_path}//.gitlab-ci.yml@${expectedRef}`;
    const primary =
      claims.project_id === String(binding.repositoryId) &&
      claims.project_path === binding.repositoryPath;
    const jobClaimsPresent =
      claims.job_project_id !== undefined ||
      claims.job_project_path !== undefined;
    const jobInSource =
      claims.job_project_id === claims.project_id &&
      claims.job_project_path === claims.project_path;
    const jobInPrimary =
      claims.job_project_id === String(binding.repositoryId) &&
      claims.job_project_path === binding.repositoryPath;
    const forkInPrimary =
      !primary &&
      claims.pipeline_source === "merge_request_event" &&
      jobInPrimary;
    const sourceConfig =
      claims.ci_config_sha === claims.sha &&
      [configRef, `https://${configRef}`, `http://${configRef}`].includes(
        claims.ci_config_ref_uri ?? "",
      );
    // GitLab omits both config claims for a fork MR executed in the parent project.
    const parentConfig =
      forkInPrimary &&
      claims.ci_config_ref_uri === null &&
      claims.ci_config_sha === null;

    if (
      (claims.project_id === String(binding.repositoryId)) !==
        (claims.project_path === binding.repositoryPath) ||
      (jobClaimsPresent && !jobInSource && !forkInPrimary) ||
      claims.ref_path !== expectedRef ||
      (!sourceConfig && !parentConfig)
    ) {
      throw new Error("Mismatched build identity");
    }

    const production = claims.environment === binding.productionEnvironment;
    const preview =
      claims.environment.startsWith(binding.previewEnvironmentPrefix) &&
      claims.environment.length > binding.previewEnvironmentPrefix.length;

    if (production) {
      if (
        !primary ||
        claims.pipeline_source === "merge_request_event" ||
        ![true, "true"].includes(claims.ref_protected) ||
        !binding.productionRefs.some((ref) =>
          ref.endsWith("*")
            ? expectedRef.startsWith(ref.slice(0, -1))
            : expectedRef === ref,
        )
      ) {
        throw new Error("Production build is not trusted");
      }
    } else if (
      !preview ||
      claims.ref_type !== "branch" ||
      (!primary && claims.pipeline_source !== "merge_request_event")
    ) {
      throw new Error("Unknown build environment");
    }

    const project = await service.db.project.findFirst({
      where: { id: projectId, enabled: true, deletedAt: null },
      select: { id: true, sourceMapPolicy: true },
    });

    if (!project) {
      throw new Error("Inactive build project");
    }

    const policy = effectiveSourceMapPolicy(
      project.sourceMapPolicy,
      gitlabBinding(service, projectId)!.key,
    );
    const allowedSource =
      primary ||
      policy.trustedSources.some(
        (source) =>
          String(source.repositoryId) === claims.project_id &&
          source.repositoryPath === claims.project_path,
      );

    if (!allowedSource) {
      return {
        version: 2,
        sourceMaps: { enabled: false, reason: "source_not_allowed" },
      };
    }

    const review =
      !production && claims.pipeline_source === "merge_request_event"
        ? /^pr-([1-9][0-9]*)$/.exec(
            claims.environment.slice(binding.previewEnvironmentPrefix.length),
          )
        : null;

    return ciContextSchema.parse({
      version: 2,
      sourceMaps:
        production || policy.previewEnabled
          ? { enabled: true }
          : { enabled: false, reason: "preview_disabled" },
      release: `${binding.releasePrefix}@${claims.sha}`,
      assetPrefix: `assets/ge-gl-${binding.repositoryId}-${claims.job_id}/`,
      deployment: {
        environment: production ? "production" : "staging",
        ...(review
          ? {
              review: {
                provider: "gitlab",
                repositoryId: binding.repositoryId,
                number: Number(review[1]),
              },
            }
          : {}),
      },
    });
  } catch {
    // Never expose JWT claims, key material or validation-library errors.
    throw new AuthError(401);
  }
}
