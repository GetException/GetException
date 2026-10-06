import type { Page } from "@playwright/test";

const TRANSIENT_ERRORS = [
  "ERR_CONNECTION_RESET",
  "ERR_CONNECTION_CLOSED",
  "ERR_EMPTY_RESPONSE",
  "ERR_NETWORK_CHANGED",
  "ERR_SOCKET_NOT_CONNECTED",
  "ERR_HTTP2_PROTOCOL_ERROR",
  "ERR_ABORTED",
] as const;

export class NavigationFailure extends Error {
  constructor(readonly code: string) {
    super("Navigation failed: " + code);
  }
}

export async function openPage(
  page: Pick<Page, "goto" | "waitForTimeout">,
  url: string,
) {
  for (let attempt = 0; attempt < 3; attempt += 1) {
    try {
      // Resolve the document before a streamed Next.js redirect starts a new navigation.
      return await page.goto(url, { waitUntil: "commit" });
    } catch (error) {
      const code =
        error instanceof Error
          ? TRANSIENT_ERRORS.find((name) =>
              error.message.includes("net::" + name),
            )
          : undefined;

      if (!code || attempt === 2) {
        // Never serialize URLs, credentials or arbitrary exception messages.
        throw new NavigationFailure(code ?? "UNCLASSIFIED");
      }

      // Retry only navigation GETs; assertions and authentication requests are not retried.
      await page.waitForTimeout(250 * (attempt + 1));
    }
  }

  throw new NavigationFailure("UNCLASSIFIED");
}
