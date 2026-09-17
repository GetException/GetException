import { z } from "zod";

export const SOURCE_MAP_LIMITS = {
  files: 128,
  fileBytes: 16 * 1024 * 1024,
  releaseBytes: 128 * 1024 * 1024,
  projectBytes: 1024 * 1024 * 1024,
  installationBytes: 10 * 1024 * 1024 * 1024,
  manifestBytes: 64 * 1024,
} as const;

export const releaseNameSchema = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,79}@[a-f0-9]{40}$/);

export const artifactPathSchema = z
  .string()
  .max(512)
  .regex(/^[a-zA-Z0-9_@~.-]+(?:\/[a-zA-Z0-9_@~.-]+)*\.(?:js|mjs)$/)
  .refine(
    (value) => !value.split("/").some((part) => part === "." || part === ".."),
  );

export const sourceArtifactSchema = z
  .object({
    path: artifactPathSchema,
    debugId: z.string().uuid(),
    sha256: z.string().regex(/^[a-f0-9]{64}$/),
    size: z.number().int().min(2).max(SOURCE_MAP_LIMITS.fileBytes),
  })
  .strict();

export const sourceUploadSchema = z
  .object({
    release: releaseNameSchema,
    artifacts: z
      .array(sourceArtifactSchema)
      .min(1)
      .max(SOURCE_MAP_LIMITS.files),
  })
  .strict()
  .superRefine((value, ctx) => {
    if (
      value.artifacts.reduce((sum, file) => sum + file.size, 0) >
        SOURCE_MAP_LIMITS.releaseBytes ||
      new Set(value.artifacts.map((file) => file.path)).size !==
        value.artifacts.length ||
      new Set(value.artifacts.map((file) => file.debugId)).size !==
        value.artifacts.length
    ) {
      ctx.addIssue({ code: "custom", message: "Invalid artifact manifest" });
    }
  });

export type SourceUpload = z.infer<typeof sourceUploadSchema>;

export type SourceArtifactInput = z.infer<typeof sourceArtifactSchema>;

export const originalFrameSchema = z
  .object({
    filename: z.string().max(512),
    function: z.string().max(160),
    lineno: z.number().int().min(1),
    colno: z.number().int().min(0),
    contextLine: z.string().max(2000).optional(),
    preContext: z.array(z.string().max(2000)).max(3),
    postContext: z.array(z.string().max(2000)).max(3),
  })
  .strict();

export type OriginalFrame = z.infer<typeof originalFrameSchema>;
