import { createLocalJWKSet, jwtVerify } from "jose";
import { z } from "zod";
import { parseGitlabTrust } from "@getexception/config";
import { buildContextSchema, type BuildContext } from "@getexception/protocol";
import type { AuthService } from "../auth-service";
import { AuthError } from "../auth-error";

const identifier = z
  .union([
    z.string().regex(/^[1-9][0-9]{0,14}$/),
    z.number().int().positive().max(Number.MAX_SAFE_INTEGER),
  ])
  .transform(String);
const claimsSchema = z.object({
  project_id: identifier,
  project_path: z.string(),
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
  ci_config_ref_uri: z.string().max(1024),
  ci_config_sha: z.string().regex(/^[a-f0-9]{40}$/),
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
): Promise<BuildContext> {
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
    const configRef = `${new URL(trust.issuer).host}/${binding.repositoryPath}//.gitlab-ci.yml@${expectedRef}`;

    if (
      claims.project_id !== String(binding.repositoryId) ||
      claims.project_path !== binding.repositoryPath ||
      (claims.job_project_id !== undefined &&
        claims.job_project_id !== claims.project_id) ||
      (claims.job_project_path !== undefined &&
        claims.job_project_path !== claims.project_path) ||
      claims.ref_path !== expectedRef ||
      claims.ci_config_sha !== claims.sha ||
      ![configRef, `https://${configRef}`, `http://${configRef}`].includes(
        claims.ci_config_ref_uri,
      )
    ) {
      throw new Error("Mismatched build identity");
    }

    const production = claims.environment === binding.productionEnvironment;
    const preview =
      claims.environment.startsWith(binding.previewEnvironmentPrefix) &&
      claims.environment.length > binding.previewEnvironmentPrefix.length;

    if (production) {
      if (
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
    } else if (!preview || claims.ref_type !== "branch") {
      throw new Error("Unknown build environment");
    }

    const project = await service.db.project.findFirst({
      where: { id: projectId, enabled: true, deletedAt: null },
      select: { id: true },
    });

    if (!project) {
      throw new Error("Inactive build project");
    }

    const review =
      !production && claims.pipeline_source === "merge_request_event"
        ? /^pr-([1-9][0-9]*)$/.exec(
            claims.environment.slice(binding.previewEnvironmentPrefix.length),
          )
        : null;

    return buildContextSchema.parse({
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
