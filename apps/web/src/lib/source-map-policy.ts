import { z } from "zod";

export const MAX_PREVIEW_SOURCES = 20;

export const previewSourceSchema = z
  .object({
    repositoryId: z.number().int().min(1).max(2147483647),
    repositoryPath: z
      .string()
      .trim()
      .max(255)
      .regex(/^[A-Za-z0-9_.-]+(?:\/[A-Za-z0-9_.-]+)+$/),
  })
  .strict();

export const sourceMapPolicySchema = z
  .object({
    previewEnabled: z.boolean(),
    trustedSources: z.array(previewSourceSchema).max(MAX_PREVIEW_SOURCES),
  })
  .strict()
  .refine(
    ({ trustedSources }) =>
      new Set(trustedSources.map((source) => source.repositoryId)).size ===
        trustedSources.length &&
      new Set(trustedSources.map((source) => source.repositoryPath)).size ===
        trustedSources.length,
    "Each repository must appear once.",
  );

export type PreviewSource = z.infer<typeof previewSourceSchema>;

export type SourceMapPolicy = z.infer<typeof sourceMapPolicySchema>;

export const DEFAULT_SOURCE_MAP_POLICY: SourceMapPolicy = {
  previewEnabled: false,
  trustedSources: [],
};

export type SourceMapSettings = SourceMapPolicy & {
  repository: PreviewSource;
  gitlabOrigin: string;
};
