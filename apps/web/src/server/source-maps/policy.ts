import { createHash } from "node:crypto";
import { parseGitlabTrust } from "@getexception/config";
import type { AuthService } from "../auth-service";
import { AuthError } from "../auth-error";
import { ownerTransaction } from "../owner-transaction";
import {
  DEFAULT_SOURCE_MAP_POLICY,
  sourceMapPolicySchema,
  type SourceMapSettings,
} from "../../lib/source-map-policy";

export function gitlabBinding(service: AuthService, projectId: string) {
  const raw = service.config.GITLAB_CI_TRUST;

  if (!raw) {
    return null;
  }

  const trust = parseGitlabTrust(raw);
  const binding = trust.projects.find((entry) => entry.projectId === projectId);

  if (!binding) {
    return null;
  }

  const key = createHash("sha256")
    .update(
      JSON.stringify([
        trust.issuer,
        binding.repositoryId,
        binding.repositoryPath,
        binding.releasePrefix,
      ]),
    )
    .digest("hex");

  return { binding, key, issuer: trust.issuer };
}

export function effectiveSourceMapPolicy(
  stored: {
    bindingKey: string;
    previewEnabled: boolean;
    trustedSources: unknown;
  } | null,
  bindingKey: string,
) {
  return stored?.bindingKey === bindingKey
    ? sourceMapPolicySchema.parse({
        previewEnabled: stored.previewEnabled,
        trustedSources: stored.trustedSources,
      })
    : DEFAULT_SOURCE_MAP_POLICY;
}

export async function sourceMapSettings(
  service: AuthService,
  projectId: string,
): Promise<SourceMapSettings | null> {
  const trusted = gitlabBinding(service, projectId);

  if (!trusted) {
    return null;
  }

  const stored = await service.db.sourceMapPolicy.findUnique({
    where: { projectId },
  });
  const origin = new URL(trusted.issuer);

  origin.protocol = "https:";

  return {
    ...effectiveSourceMapPolicy(stored, trusted.key),
    repository: {
      repositoryId: trusted.binding.repositoryId,
      repositoryPath: trusted.binding.repositoryPath,
    },
    gitlabOrigin: origin.origin,
  };
}

export async function updateSourceMapPolicy(
  service: AuthService,
  headers: Headers,
  projectId: string,
  input: unknown,
) {
  const data = sourceMapPolicySchema.safeParse(input);

  if (!data.success) {
    throw new AuthError(400, "source_map_policy_invalid");
  }

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

    const trusted = gitlabBinding(service, projectId);

    if (!trusted) {
      throw new AuthError(409, "source_map_ci_unconfigured");
    }

    if (
      data.data.trustedSources.some(
        (source) =>
          source.repositoryId === trusted.binding.repositoryId ||
          source.repositoryPath === trusted.binding.repositoryPath,
      )
    ) {
      throw new AuthError(400, "source_map_primary_repository");
    }

    const values = { ...data.data, bindingKey: trusted.key };

    await tx.sourceMapPolicy.upsert({
      where: { projectId },
      create: { projectId, ...values },
      update: values,
    });
    await service.audit(tx, "source_map_policy_update", true, current.user.id);

    return { ok: true };
  });
}
