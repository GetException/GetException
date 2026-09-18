import { ciFailureSchema } from "@getexception/protocol";
import { CliError, networkError } from "./diagnostics";

export async function responseJson(response: Response): Promise<unknown> {
  const reader = response.body?.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;

  if (!reader) {
    throw new CliError("CONTRACT_JSON", response.status);
  }

  try {
    for (;;) {
      const { done, value } = await reader.read();

      if (done) {
        break;
      }

      size += value.length;

      if (size > 128 * 1024) {
        await reader.cancel().catch(() => undefined);

        throw new CliError("CONTRACT_RESPONSE", response.status);
      }

      chunks.push(value);
    }
  } catch (error) {
    throw error instanceof CliError
      ? error
      : networkError(error, response.status);
  } finally {
    reader.releaseLock();
  }

  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks)),
    );
  } catch {
    throw new CliError("CONTRACT_JSON", response.status);
  }
}

export async function httpError(response: Response): Promise<CliError> {
  try {
    const value = await responseJson(response);

    if (value && typeof value === "object" && !Array.isArray(value)) {
      const candidate = value as Record<string, unknown>;
      const result = ciFailureSchema.safeParse({
        code: candidate.code,
        requestId: candidate.requestId,
      });

      if (result.success) {
        return new CliError(
          result.data.code,
          response.status,
          result.data.requestId,
        );
      }
    }
  } catch {
    // Non-JSON/proxy/oversized responses still report the known HTTP status only.
  }

  return new CliError("HTTP_ERROR", response.status);
}
