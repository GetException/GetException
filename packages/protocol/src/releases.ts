import { z } from "zod";
import { releaseNameSchema } from "./source-maps";

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
    deployment: deploymentSchema,
  })
  .strict();

export type ReleaseDeploymentInput = z.infer<typeof deploymentSchema>;
