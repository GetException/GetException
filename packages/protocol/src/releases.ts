import { z } from "zod";
import { releaseNameSchema } from "./source-maps";

export const appVersionSchema = z
  .string()
  .max(64)
  .refine((value) => value.trim() === value)
  .regex(
    /^(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})\.(0|[1-9][0-9]{0,9})(?:-(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*)(?:\.(?:0|[1-9][0-9]*|[0-9]*[a-zA-Z-][0-9a-zA-Z-]*))*)?(?:\+[0-9a-zA-Z-]+(?:\.[0-9a-zA-Z-]+)*)?$/,
  );

export function sanitizeAppVersion(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 64) {
    return undefined;
  }

  const parsed = appVersionSchema.safeParse(value);

  return parsed.success ? parsed.data : undefined;
}

export const RELEASE_ENVIRONMENTS = [
  "production",
  "staging",
  "development",
] as const;

export const deploymentSchema = z
  .object({
    environment: z.enum(RELEASE_ENVIRONMENTS),
    review: z
      .object({
        provider: z.literal("gitlab"),
        repositoryId: z.number().int().min(1).max(2147483647),
        number: z.number().int().min(1).max(2147483647),
      })
      .strict()
      .optional(),
  })
  .strict()
  .refine((value) => !value.review || value.environment === "staging", {
    message: "Merge requests belong to staging",
  });

export const releaseRegistrationSchema = z
  .object({
    release: releaseNameSchema,
    appVersion: appVersionSchema.optional(),
    deployment: deploymentSchema,
  })
  .strict();

export type ReleaseDeploymentInput = z.infer<typeof deploymentSchema>;
