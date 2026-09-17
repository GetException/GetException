import { z } from "zod";
import { setTimeout as delay } from "node:timers/promises";

export function projectApi(
  address: string,
  project: string,
  token: string,
  transport: typeof fetch = fetch,
) {
  const url = new URL(address);

  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  ) {
    throw new Error("Use the HTTPS dashboard origin");
  }

  if (
    !z.string().uuid().safeParse(project).success ||
    !/^[a-f0-9]{64}$/.test(token)
  ) {
    throw new Error("Set a valid project ID and GETEXCEPTION_UPLOAD_TOKEN");
  }

  const base = `${url.origin}/api/v1/projects/${project}`;
  const deadline = Date.now() + 120_000;

  return async function request(
    path: string,
    method = "GET",
    body?: string | Uint8Array,
  ): Promise<unknown> {
    for (let attempt = 0; attempt < 3; attempt++) {
      if (Date.now() >= deadline) {
        throw new Error("Upload timed out; retain private artifacts and retry");
      }

      const response = await transport(base + path, {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          "Content-Type": "application/json",
        },
        body: body as BodyInit | undefined,
        redirect: "error",
        credentials: "omit",
        signal: AbortSignal.timeout(Math.min(30_000, deadline - Date.now())),
      });

      if (response.ok) {
        return response.json();
      }

      if ((response.status === 429 || response.status >= 500) && attempt < 2) {
        await response.body?.cancel();
        await delay(1000 * 2 ** attempt);

        continue;
      }

      await response.body?.cancel();

      throw new Error(`Source map API returned HTTP ${response.status}`);
    }

    throw new Error("Upload failed");
  };
}
