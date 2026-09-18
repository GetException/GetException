import { z } from "zod";

// Only these fixed codes may cross the CI API/log boundary. Never include claims.
export const ciFailureCodeSchema = z.enum([
  "CI_TOKEN_MISSING",
  "CI_TOKEN_INVALID",
  "CI_TRUST_UNCONFIGURED",
  "CI_IDENTITY_KEY",
  "CI_IDENTITY_SIGNATURE",
  "CI_IDENTITY_ISSUER",
  "CI_IDENTITY_AUDIENCE",
  "CI_IDENTITY_EXPIRED",
  "CI_IDENTITY_TIME",
  "CI_IDENTITY_HEADER",
  "CI_IDENTITY_CLAIMS",
  "CI_IDENTITY_SOURCE",
  "CI_IDENTITY_EXECUTION",
  "CI_IDENTITY_REF",
  "CI_IDENTITY_CONFIG",
  "CI_IDENTITY_ENVIRONMENT",
  "CI_IDENTITY_PRODUCTION",
  "CI_PROJECT_UNAVAILABLE",
  "CI_POLICY_DENIED",
  "CI_ORIGIN_FORBIDDEN",
  "CI_CONTRACT_VERSION",
  "CI_RATE_LIMITED",
  "CI_SERVER_ERROR",
]);

export type CiFailureCode = z.infer<typeof ciFailureCodeSchema>;

export const ciFailureSchema = z
  .object({
    code: ciFailureCodeSchema,
    requestId: z.string().uuid(),
  })
  .strict();
