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
