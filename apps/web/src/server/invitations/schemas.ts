import { z } from "zod";
import { emailSchema } from "../auth-schemas";

export const invitationInput = z
  .object({
    email: emailSchema,
    role: z.enum(["developer", "viewer"]),
    teamIds: z
      .array(z.string().uuid())
      .min(1)
      .max(50)
      .transform((values) => [...new Set(values)]),
  })
  .strict();

export const tokenInput = z
  .object({ token: z.string().regex(/^[a-f0-9]{64}$/) })
  .strict();

export const registrationInput = z
  .object({
    name: z.string().trim().min(1).max(80),
    password: z.string().min(12).max(128),
  })
  .strict();

export const INVITATION_TTL = 48 * 3600_000;

export const VERIFICATION_TTL = 15 * 60_000;

export const REGISTRATION_COOKIE = "__Host-getexception.registration";
