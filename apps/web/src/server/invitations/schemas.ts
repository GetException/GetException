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
    name: z.string().trim().min(2).max(80),
    password: z.string().min(12).max(128),
  })
  .strict();

export const beginRegistrationInput = registrationInput.extend({
  token: z.string().regex(/^[a-f0-9]{64}$/),
});

export const codeInput = z
  .object({ code: z.string().regex(/^\d{6}$/) })
  .strict();

export const finishRegistrationInput = codeInput.extend({
  enrollment: z.string().regex(/^[a-f0-9]{64}$/),
});

export const INVITATION_TTL = 24 * 3600_000;

export const ENROLLMENT_TTL = 15 * 60_000;

export const ENROLLMENT_COOKIE = "__Host-getexception.invitation-enrollment";
