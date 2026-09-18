import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";
import { authorizationHeader, type CiCredential } from "./credentials";
import { CliError, networkError } from "./diagnostics";
import { responseJson, httpError } from "./api-response";

export function projectApi(
  address: string,
  project: string,
  token: CiCredential,
  transport: typeof fetch = fetch,
) {
  let url: URL;

  try {
    url = new URL(address);
  } catch {
    throw new CliError("CLI_CONFIGURATION");
  }

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new CliError("CLI_CONFIGURATION");
  }

  if (!z.string().uuid().safeParse(project).success) {
    throw new CliError("CLI_CONFIGURATION");
  }

  const authorization = authorizationHeader(token);
  const base = `${url.origin}/api/v1/projects/${project}`;
  const deadline = Date.now() + 120_000;

  return async function request(
    path: string,
    method = "GET",
    body?: string | Uint8Array,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Date.now() >= deadline) {
        throw new CliError("NETWORK_TIMEOUT");
      }

      let response: Response;

      try {
        response = await transport(base + path, {
          method,
          headers: {
            Authorization: authorization,
            "Content-Type": "application/json",
          },
          body: body as BodyInit | undefined,
          redirect: "error",
          credentials: "omit",
          signal: AbortSignal.timeout(Math.min(30_000, deadline - Date.now())),
        });
      } catch (error) {
        throw networkError(error);
      }

      if (response.ok) {
        return responseJson(response);
      }

      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await response.body?.cancel().catch(() => undefined);
        await delay(1000 * 2 ** attempt);

        continue;
      }

      throw await httpError(response);
    }

    throw new CliError("COMMAND_FAILED");
  };
}
