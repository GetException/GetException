import { z } from "zod";
import { releaseNameSchema } from "./source-maps";
import { deploymentSchema } from "./releases";

export const buildContextSchema = z
  .object({
    release: releaseNameSchema,
    assetPrefix: z.string().regex(/^assets\/ge-gl-[1-9][0-9]*-[1-9][0-9]*\/$/),
    deployment: deploymentSchema,
  })
  .strict();

export type BuildContext = z.infer<typeof buildContextSchema>;

const sourceMaps = z.discriminatedUnion("enabled", [
  z.object({ enabled: z.literal(true) }).strict(),
  z
    .object({
      enabled: z.literal(false),
      reason: z.literal("preview_disabled"),
    })
    .strict(),
]);

export const ciContextSchema = z.union([
  buildContextSchema
    .extend({ version: z.literal(2), sourceMaps })
    .refine(
      (context) =>
        context.sourceMaps.enabled ||
        context.deployment.environment === "staging",
      "Only preview builds may skip source maps",
    ),
  z
    .object({
      version: z.literal(2),
      sourceMaps: z
        .object({
          enabled: z.literal(false),
          reason: z.literal("source_not_allowed"),
        })
        .strict(),
    })
    .strict(),
]);

export type CiContext = z.infer<typeof ciContextSchema>;
