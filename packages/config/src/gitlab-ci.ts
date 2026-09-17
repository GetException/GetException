import { z } from "zod";

const origin = z
  .string()
  .url()
  .max(255)
  .refine((value) => {
    const url = new URL(value);

    return ["https:", "http:"].includes(url.protocol) && url.origin === value;
  });
const publicKey = z
  .object({
    kty: z.literal("RSA"),
    kid: z.string().min(1).max(256),
    n: z.string().regex(/^[A-Za-z0-9_-]{342,1366}$/),
    e: z.literal("AQAB"),
    alg: z.literal("RS256").optional(),
    use: z.literal("sig").optional(),
    key_ops: z.array(z.literal("verify")).length(1).optional(),
  })
  .strict();

const binding = z
  .object({
    projectId: z.string().uuid(),
    repositoryId: z.number().int().min(1).max(2147483647),
    repositoryPath: z
      .string()
      .max(255)
      .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/),
    releasePrefix: z.string().regex(/^[a-z0-9][a-z0-9-]{0,79}$/),
    previewEnvironmentPrefix: z
      .string()
      .regex(/^[A-Za-z0-9_-]+\/$/)
      .default("review/"),
    productionEnvironment: z.string().min(1).max(255).optional(),
    productionRefs: z
      .array(
        z
          .string()
          .max(255)
          .regex(/^refs\/(?:heads|tags)\/[A-Za-z0-9_./-]+\*?$/),
      )
      .max(20)
      .default([]),
  })
  .strict();

export const gitlabTrustSchema = z
  .object({
    issuer: origin,
    jwks: z.object({ keys: z.array(publicKey).min(1).max(10) }).strict(),
    projects: z.array(binding).min(1).max(20),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      new Set(value.jwks.keys.map((key) => key.kid)).size !==
        value.jwks.keys.length ||
      new Set(value.projects.map((project) => project.projectId)).size !==
        value.projects.length ||
      value.projects.some((project) =>
        project.productionEnvironment?.startsWith(
          project.previewEnvironmentPrefix,
        ),
      )
    ) {
      ctx.addIssue({
        code: "custom",
        message: "Ambiguous GitLab trust policy",
      });
    }
  });

export function parseGitlabTrust(value: string) {
  if (value.length > 65536) {
    throw new Error("GitLab trust policy is too large");
  }

  return gitlabTrustSchema.parse(JSON.parse(value));
}
