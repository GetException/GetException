import { z } from "zod";
import { canonicalOrigin } from "@getexception/config";
import { AuthError } from "./auth-error";

export const projectInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    slug: z.string().regex(/^[a-z0-9][a-z0-9-]{0,63}$/),
    origins: z
      .array(z.string().max(300))
      .min(1)
      .max(20)
      .transform((values) => [...new Set(values.map(projectOrigin))]),
  })
  .strict();

function projectOrigin(value: string): string {
  try {
    // Monitored applications can run locally while the dashboard is hosted remotely.
    return canonicalOrigin(value, true);
  } catch {
    throw new AuthError(400, "project_origin");
  }
}
