import { expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import { temporaryDatabase } from "./database";
import { availablePort } from "../../scripts/local/state";
import { launch, ready, stopChild } from "../../scripts/local/processes";

it("serves invitation pages with working per-request script nonces and rejects unauthorized HTTP mutations", async () => {
  const database = await temporaryDatabase();
  const port = await availablePort();
  const origin = "https://monitor.localhost";
  const secret = () => randomBytes(32).toString("hex");
  const child = launch(process.execPath, ["apps/web/dist/start.js"], {
    DATABASE_URL: database.urls.web,
    PORT: String(port),
    BIND_HOST: "127.0.0.1",
    DASHBOARD_ORIGIN: origin,
    INGEST_ORIGIN: "https://ingest.monitor.localhost",
    BETTER_AUTH_SECRET: secret(),
    TOTP_ENCRYPTION_KEY: secret(),
    MAIL_ENCRYPTION_KEY: secret(),
    MAIL_ENABLED: "true",
    AUTH_RATE_KEY: secret(),
  });

  try {
    await ready(child, port, "Test web");
    const nonces = new Set<string>();

    for (const path of ["/invite", "/invite/verify", "/invite/register"]) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`);

      expect(response.status).toBe(200);
      expect(response.headers.get("cache-control")).toContain("no-store");
      const nonce = /'nonce-([^']+)'/.exec(
        response.headers.get("content-security-policy") ?? "",
      )?.[1];

      expect(nonce).toBeDefined();
      nonces.add(nonce!);
      const scripts = (await response.text()).match(/<script\b[^>]*>/g) ?? [];

      expect(scripts.length).toBeGreaterThan(0);
      expect(
        scripts.every((script) => script.includes(`nonce="${nonce}"`)),
      ).toBe(true);
    }

    expect(nonces.size).toBe(3);
    const post = (path: string, requestOrigin = origin) =>
      fetch(`http://127.0.0.1:${port}${path}`, {
        method: "POST",
        headers: { Origin: requestOrigin, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: "viewer@example.test",
          role: "viewer",
          teamIds: [crypto.randomUUID()],
        }),
      });

    expect((await post("/api/dashboard/access/invitations")).status).toBe(401);
    expect(
      (await post("/api/invitations/preview", "https://other.example.test"))
        .status,
    ).toBe(403);
    expect((await post("/api/auth/sign-up/email")).status).toBe(404);
  } finally {
    await stopChild(child);
    await database.cleanup();
  }
}, 60_000);
