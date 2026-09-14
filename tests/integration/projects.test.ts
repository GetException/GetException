import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase, createIngestDatabase } from "@getexception/db";
import { encodeEnvelope, sanitizeEvent } from "@getexception/protocol";
import { temporaryDatabase } from "./database";
import * as runtimes from "../../apps/web/src/server/runtime";
import { POST } from "../../apps/web/src/app/api/dashboard/projects/route";
import { digest, token, totp } from "../../apps/web/src/server/crypto";
import { createIngestServer } from "../../apps/ingest/src/server";

let database: Awaited<ReturnType<typeof temporaryDatabase>>;
let web: ReturnType<typeof createDatabase>;
let ingest: ReturnType<typeof createIngestDatabase>;
let runtime: ReturnType<typeof runtimes.createRuntime>;
let cookie: string;
const dashboardOrigin = "https://monitor.example.test";
const ingestOrigin = "https://ingest.example.test";

beforeAll(async () => {
  database = await temporaryDatabase();
  web = createDatabase(database.urls.web);
  ingest = createIngestDatabase(database.urls.ingest);
  runtime = runtimes.createRuntime(
    {
      DATABASE_URL: database.urls.web,
      DASHBOARD_ORIGIN: dashboardOrigin,
      INGEST_ORIGIN: ingestOrigin,
      BETTER_AUTH_SECRET: token(),
      TOTP_ENCRYPTION_KEY: token(),
      AUTH_RATE_KEY: token(),
      MAIL_ENCRYPTION_KEY: token(),
      MAIL_ENABLED: false,
    },
    web,
  );
  vi.spyOn(runtimes, "getRuntime").mockReturnValue(runtime);
  const bootstrap = token();
  const password = token();
  const email = "owner@example.test";

  await database.admin.bootstrapToken.create({
    data: {
      tokenHash: digest(bootstrap),
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const access = await runtime.service.setupAccess(bootstrap, "project-test");
  const pending = await runtime.service.prepareSetup(
    access,
    { email, password, domain: new URL(dashboardOrigin).hostname },
    "project-test",
  );
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());

  try {
    const period = BigInt(Math.floor(Date.now() / 30_000));

    await runtime.service.finishSetup(
      access,
      totp(pending.secret, period - 1n),
      "project-test",
    );
    const login = await runtime.auth.handler(
      new Request(dashboardOrigin + "/api/auth/owner/login", {
        method: "POST",
        headers: {
          Origin: dashboardOrigin,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
          code: totp(pending.secret, period),
          trustDevice: false,
        }),
      }),
    );

    expect(login.status).toBe(200);
    cookie = login.headers.get("set-cookie")!.split(";")[0]!;
  } finally {
    clock.mockRestore();
  }
});

afterAll(async () => {
  vi.restoreAllMocks();
  await Promise.all([web?.$disconnect(), ingest?.$disconnect()]);
  await database?.cleanup();
});

function create(origins: string[], authenticated = true) {
  return POST(
    new Request(dashboardOrigin + "/api/dashboard/projects", {
      method: "POST",
      headers: {
        Origin: dashboardOrigin,
        "Content-Type": "application/json",
        ...(authenticated ? { Cookie: cookie } : {}),
      },
      body: JSON.stringify({ name: "Account", slug: randomUUID(), origins }),
    }),
  );
}

it("returns a useful 400 for invalid origins without creating partial projects", async () => {
  const before = await web.project.count();

  for (const origin of [
    "not a URL",
    "http://app.example.com",
    "http://localhost.evil.test:8080",
    "http://localhost:8080/path",
    "https://*.example.com",
  ]) {
    const response = await create([origin]);

    expect(response.status).toBe(400);
    expect((await response.json()).error).toContain("exact HTTPS origin");
  }

  expect(await web.project.count()).toBe(before);
  expect((await create(["http://localhost:8080"], false)).status).toBe(401);
});

it("creates a local application on a hosted dashboard and accepts only allowed development events", async () => {
  const localOrigin = "http://localhost:8080";
  const remoteOrigin = "https://app.example.test";
  const response = await create([
    localOrigin,
    localOrigin + "/",
    "http://127.0.0.1:8080",
    "http://[::1]:8080",
    remoteOrigin,
  ]);

  expect(response.status).toBe(201);
  const { id, dsn } = await response.json();
  const url = new URL(dsn);

  expect(url.origin).toBe(ingestOrigin);
  expect(url.pathname).toBe("/" + id);
  const project = await web.project.findUniqueOrThrow({
    where: { id },
    include: { origins: true, keys: true, teams: true },
  });

  expect(project.origins).toHaveLength(4);
  expect(project.teams).toHaveLength(1);
  expect(project.keys[0]!.keyHash).toBe(digest(url.username));
  expect(
    await web.auditLog.count({
      where: { action: "project_create", success: true },
    }),
  ).toBe(1);

  const server = createIngestServer(ingest, { origin: ingestOrigin });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Missing test listener");
  }

  const endpoint = `http://127.0.0.1:${address.port}/api/${id}/envelope/?sentry_key=${url.username}`;
  const headers = {
    Origin: localOrigin,
    "Content-Type": "application/x-sentry-envelope",
  };

  try {
    const preflight = await fetch(endpoint, {
      method: "OPTIONS",
      headers: { ...headers, "Access-Control-Request-Method": "POST" },
    });

    expect(preflight.status).toBe(200);
    expect(preflight.headers.get("access-control-allow-origin")).toBe(
      localOrigin,
    );
    expect(
      preflight.headers.get("access-control-allow-credentials"),
    ).toBeNull();

    for (const [origin, environment, status] of [
      [localOrigin, "development", 200],
      ["http://127.0.0.1:8080", "development", 200],
      ["http://[::1]:8080", "development", 200],
      [localOrigin, "production", 403],
      [localOrigin, "staging", 403],
      ["http://localhost:8081", "development", 403],
      ["http://localhost.evil.test:8080", "development", 403],
      [remoteOrigin, "production", 200],
    ] as const) {
      const eventId = randomUUID().replaceAll("-", "");
      const result = await fetch(endpoint, {
        method: "POST",
        headers: { ...headers, Origin: origin },
        body: encodeEnvelope(
          sanitizeEvent(
            { message: "Local application test", environment },
            eventId,
          ),
        ),
      });

      expect(result.status).toBe(status);
      expect(
        await database.admin.eventInbox.count({
          where: { projectId: id, eventId },
        }),
      ).toBe(status === 200 ? 1 : 0);
    }
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }
});
