import { randomUUID } from "node:crypto";
import { errors } from "jose";
import { ciFailureSchema, type CiFailureCode } from "@getexception/protocol";
import { AuthError } from "../auth-error";

export class CiAuthError extends AuthError {
  constructor(
    public readonly code: CiFailureCode,
    status = 401,
  ) {
    super(status);
  }
}

export function identityFailure(error: unknown): CiAuthError {
  if (error instanceof errors.JWKSNoMatchingKey) {
    return new CiAuthError("CI_IDENTITY_KEY");
  }

  if (error instanceof errors.JWSSignatureVerificationFailed) {
    return new CiAuthError("CI_IDENTITY_SIGNATURE");
  }

  if (error instanceof errors.JWTExpired) {
    return new CiAuthError("CI_IDENTITY_EXPIRED");
  }

  if (error instanceof errors.JWTClaimValidationFailed) {
    if (error.claim === "iss") {
      return new CiAuthError("CI_IDENTITY_ISSUER");
    }

    if (error.claim === "aud") {
      return new CiAuthError("CI_IDENTITY_AUDIENCE");
    }

    return new CiAuthError(
      ["iat", "nbf", "exp"].includes(error.claim)
        ? "CI_IDENTITY_TIME"
        : "CI_IDENTITY_CLAIMS",
    );
  }

  return new CiAuthError("CI_TOKEN_INVALID");
}

export function ciFailure(error: CiAuthError) {
  const failure = ciFailureSchema.parse({
    code: error.code,
    requestId: randomUUID(),
  });

  // A server-generated ID correlates the response and log without JWTs or headers.
  console.warn(
    JSON.stringify({
      event: "ci_request_failed",
      ...failure,
      httpStatus: error.status,
    }),
  );

  return failure;
}
