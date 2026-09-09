import { z } from "zod";

export const emailSchema = z.string().trim().toLowerCase().email().max(254);

export const loginSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(1).max(128),
    code: z
      .string()
      .regex(/^\d{6}$/)
      .optional(),
    recoveryCode: z
      .string()
      .regex(/^[a-f0-9]{32}$/)
      .optional(),
    trustDevice: z.literal(false),
  })
  .strict()
  .refine((data) => !(data.code && data.recoveryCode));

export const prepareSetupSchema = z
  .object({
    email: emailSchema,
    password: z.string().min(12).max(128),
    domain: z.string().max(253),
  })
  .strict();

export const stepUpSchema = z
  .object({
    password: z.string().min(1).max(128),
    code: z.string().regex(/^\d{6}$/),
    trustDevice: z.literal(false),
  })
  .strict();
