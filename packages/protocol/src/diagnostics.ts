import { z } from "zod";
import { record } from "./json";

export const API_REASONS = [
  "network_error",
  "timeout",
  "aborted",
  "unauthorized",
  "forbidden",
  "not_found",
  "validation_error",
  "conflict",
  "rate_limited",
  "server_error",
] as const;

export const apiContextSchema = z
  .object({
    code: z
      .string()
      .regex(/^(?:[a-zA-Z][a-zA-Z0-9_.-]{0,63}|[0-9]{1,6})$/)
      .optional(),
    reason: z.enum(API_REASONS).optional(),
    status_code: z.number().int().min(100).max(599).optional(),
  })
  .strict();

export const BROWSER_NAMES = [
  "Chrome",
  "Edge",
  "Firefox",
  "Safari",
  "Opera",
  "Samsung Internet",
] as const;

export const browserContextSchema = z
  .object({
    name: z.enum(BROWSER_NAMES),
    major: z.number().int().min(1).max(9999),
  })
  .strict();

export type ApiContext = z.infer<typeof apiContextSchema>;

export type BrowserContext = z.infer<typeof browserContextSchema>;

export function sanitizeApiContext(value: unknown): ApiContext | undefined {
  const input = record(value);
  const out: ApiContext = {};

  for (const key of ["code", "reason", "status_code"] as const) {
    const parsed = apiContextSchema.shape[key].safeParse(input[key]);

    if (parsed.success && parsed.data !== undefined) {
      Object.defineProperty(out, key, { value: parsed.data, enumerable: true });
    }
  }

  return Object.keys(out).length ? out : undefined;
}

export function sanitizeBrowserContext(
  value: unknown,
): BrowserContext | undefined {
  const input = record(value);
  const parsed = browserContextSchema.safeParse({
    name: input.name,
    major: input.major,
  });

  return parsed.success ? parsed.data : undefined;
}
