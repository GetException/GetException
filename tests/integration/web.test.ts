import { expect, it } from "vitest";
import { randomBytes, randomUUID, createHash } from "node:crypto";
import { join } from "node:path";
import { digest } from "../../apps/web/src/server/crypto";
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
    SOURCE_MAP_DIR: join(database.directory, "maps"),
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

    const organization = await database.admin.organization.create({
      data: { id: randomUUID(), name: "HTTP maps", slug: "http-maps" },
    });
    const project = await database.admin.project.create({
      data: {
        organizationId: organization.id,
        name: "HTTP maps",
        slug: "http-maps",
      },
    });
    const uploadToken = secret();

    await database.admin.sourceMapToken.create({
      data: {
        projectId: project.id,
        name: "CI",
        tokenHash: digest(uploadToken),
        expiresAt: new Date(Date.now() + 60000),
      },
    });
    const base = `http://127.0.0.1:${port}/api/v1/projects/${project.id}/source-maps`;
    const ciBase = `http://127.0.0.1:${port}/api/v1/projects/${project.id}/ci`;
    const requestIds = new Set<string>();

    for (const [query, extraHeaders, status, code] of [
      ["?version=2", {}, 401, "CI_TOKEN_MISSING"],
      ["?version=999", {}, 400, "CI_CONTRACT_VERSION"],
      ["?version=2", { Origin: origin }, 403, "CI_ORIGIN_FORBIDDEN"],
    ] as const) {
      const response = await fetch(ciBase + query, {
        method: "POST",
        headers: { ...extraHeaders, "X-Forwarded-Proto": "https" },
      });
      const result = await response.json();

      expect(response.status).toBe(status);
      expect(response.headers.get("cache-control")).toBe("no-store");
      expect(result).toEqual({
        error: "CI request failed",
        code,
        requestId: expect.stringMatching(/^[a-f0-9-]{36}$/),
      });
      requestIds.add(result.requestId);
    }

    expect(requestIds.size).toBe(3);
    const debugId = randomUUID();
    const payload =
      JSON.stringify({
        version: 3,
        debug_id: debugId,
        file: "app.js",
        sources: ["src/app.ts"],
        sourcesContent: ["throw Error('mapped');"],
        names: [],
        mappings: "AAAA",
      }) + " ".repeat(10 * 1024 * 1024 + 1);
    const manifest = {
      release: `http-maps@${"a".repeat(40)}`,
      artifacts: [
        {
          path: "app.js",
          debugId,
          sha256: createHash("sha256").update(payload).digest("hex"),
          size: Buffer.byteLength(payload),
        },
      ],
    };
    const headers = {
      Authorization: `Bearer ${uploadToken}`,
      "Content-Type": "application/json",
      "X-Forwarded-Proto": "https",
    };

    expect(
      (
        await fetch(base, {
          method: "POST",
          headers: { ...headers, Authorization: "" },
          body: JSON.stringify(manifest),
        })
      ).status,
    ).toBe(401);
    expect(
      (
        await fetch(base, {
          method: "POST",
          headers: { ...headers, Origin: origin },
          body: JSON.stringify(manifest),
        })
      ).status,
    ).toBe(403);
    const begin = await fetch(base, {
      method: "POST",
      headers,
      body: JSON.stringify(manifest),
    });

    expect(begin.status).toBe(201);
    const receipt = await begin.json();
    const uploaded = await fetch(
      `${base}/${receipt.uploadId}/${receipt.artifacts[0].id}`,
      { method: "PUT", headers, body: payload },
    );

    expect(uploaded.status).toBe(200);
    expect(
      (await fetch(`${base}/${receipt.uploadId}`, { method: "POST", headers }))
        .status,
    ).toBe(202);
    expect(
      (
        await fetch(`${base}/${receipt.uploadId}/${receipt.artifacts[0].id}`, {
          headers,
        })
      ).status,
    ).toBe(405);

    // Exercise the compiled symbolication entry point, as shipped in Docker.
    const workerPort = await availablePort();
    const worker = launch(process.execPath, ["apps/worker/dist/main.js"], {
      DATABASE_URL: database.urls.worker,
      SOURCE_MAP_DIR: join(database.directory, "maps"),
      WORKER_CONCURRENCY: "1",
      PORT: String(workerPort),
      BIND_HOST: "127.0.0.1",
    });

    try {
      await ready(worker, workerPort, "Test worker");
      await expect
        .poll(
          async () =>
            (
              await database.admin.sourceMapUpload.findUniqueOrThrow({
                where: { id: receipt.uploadId },
              })
            ).status,
          { timeout: 10000 },
        )
        .toBe("ready");
    } finally {
      await stopChild(worker);
    }
  } finally {
    await stopChild(child);
    await database.cleanup();
  }
}, 60_000);
