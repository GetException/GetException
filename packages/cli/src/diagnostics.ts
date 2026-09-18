import { z } from "zod";
import { ciFailureCodeSchema } from "@getexception/protocol";

const codeSchema = z.enum([
  ...ciFailureCodeSchema.options,
  "CLI_CONFIGURATION",
  "NETWORK_DNS",
  "NETWORK_TLS",
  "NETWORK_CONNECTION",
  "NETWORK_TIMEOUT",
  "NETWORK_ERROR",
  "HTTP_ERROR",
  "CONTRACT_JSON",
  "CONTRACT_RESPONSE",
  "COMMAND_FAILED",
]);
const diagnosticSchema = z
  .object({
    version: z.literal(1),
    code: codeSchema,
    httpStatus: z.number().int().min(100).max(599).optional(),
    requestId: z.string().uuid().optional(),
  })
  .strict();

export class CliError extends Error {
  constructor(
    public readonly code: z.infer<typeof codeSchema>,
    public readonly httpStatus?: number,
    public readonly requestId?: string,
  ) {
    super("GetException command failed");
  }
}

export function formatDiagnostic(error: unknown): string {
  const safe = diagnosticSchema.safeParse({
    version: 1,
    code: error instanceof CliError ? error.code : "COMMAND_FAILED",
    ...(error instanceof CliError
      ? { httpStatus: error.httpStatus, requestId: error.requestId }
      : {}),
  });

  return `GETEXCEPTION_DIAGNOSTIC ${JSON.stringify(
    safe.success ? safe.data : { version: 1, code: "COMMAND_FAILED" },
  )}\n`;
}

export function networkError(error: unknown, httpStatus?: number): CliError {
  // Native errors may contain URLs/credentials. Inspect only fixed code values.
  let current = error;

  for (let depth = 0; depth < 4 && current instanceof Error; depth++) {
    const candidate = (current as Error & { code?: unknown }).code;
    const code = typeof candidate === "string" ? candidate : "";

    if (["ENOTFOUND", "EAI_AGAIN"].includes(code)) {
      return new CliError("NETWORK_DNS", httpStatus);
    }

    if (
      [
        "CERT_HAS_EXPIRED",
        "CERT_NOT_YET_VALID",
        "DEPTH_ZERO_SELF_SIGNED_CERT",
        "SELF_SIGNED_CERT_IN_CHAIN",
        "UNABLE_TO_VERIFY_LEAF_SIGNATURE",
        "UNABLE_TO_GET_ISSUER_CERT_LOCALLY",
        "ERR_TLS_CERT_ALTNAME_INVALID",
      ].includes(code)
    ) {
      return new CliError("NETWORK_TLS", httpStatus);
    }

    if (
      [
        "ETIMEDOUT",
        "UND_ERR_CONNECT_TIMEOUT",
        "UND_ERR_HEADERS_TIMEOUT",
        "UND_ERR_BODY_TIMEOUT",
      ].includes(code) ||
      current.name === "TimeoutError" ||
      current.name === "AbortError"
    ) {
      return new CliError("NETWORK_TIMEOUT", httpStatus);
    }

    if (
      ["ECONNREFUSED", "ECONNRESET", "EPIPE", "UND_ERR_SOCKET"].includes(code)
    ) {
      return new CliError("NETWORK_CONNECTION", httpStatus);
    }

    current = current.cause;
  }

  return new CliError("NETWORK_ERROR", httpStatus);
}
