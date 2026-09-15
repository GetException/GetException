import { afterAll, beforeAll, expect, it, vi } from "vitest";
import { randomUUID } from "node:crypto";
import { createDatabase, createIngestDatabase } from "@getexception/db";
import { encodeEnvelope, sanitizeEvent } from "@getexception/protocol";
import { temporaryDatabase } from "./database";
import * as runtimes from "../../apps/web/src/server/runtime";
import { POST } from "../../apps/web/src/app/api/dashboard/projects/route";
import {
  PATCH,
  DELETE,
} from "../../apps/web/src/app/api/dashboard/projects/[id]/route";
import { POST as RESTORE } from "../../apps/web/src/app/api/dashboard/projects/[id]/restore/route";
import { projectScope } from "../../apps/web/src/server/access";
import { runOne, claim } from "../../apps/worker/src/events";
import { purgeDeletedProjectBatch } from "../../apps/worker/src/project-retention";
import { digest, token, totp } from "../../apps/web/src/server/crypto";
import { createIngestServer } from "../../apps/ingest/src/server";

let database: Awaited<ReturnType<typeof temporaryDatabase>>;
let web: ReturnType<typeof createDatabase>;
let ingest: ReturnType<typeof createIngestDatabase>;
let runtime: ReturnType<typeof runtimes.createRuntime>;
let cookie: string;
let worker: ReturnType<typeof createDatabase>;
let ownerPassword: string;
let ownerSecret: string;
const dashboardOrigin = "https://monitor.example.test";
const ingestOrigin = "https://ingest.example.test";

beforeAll(async () => {
  database = await temporaryDatabase();
  web = createDatabase(database.urls.web);
  worker = createDatabase(database.urls.worker);
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

  ownerPassword = password;
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

  ownerSecret = pending.secret;
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
  await Promise.all([
    web?.$disconnect(),
    ingest?.$disconnect(),
    worker?.$disconnect(),
  ]);
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

function change(
  id: string,
  method: "PATCH" | "DELETE" | "RESTORE",
  data: unknown,
  overrides: Record<string, string> = {},
) {
  const handler =
    method === "PATCH" ? PATCH : method === "DELETE" ? DELETE : RESTORE;

  return handler(
    new Request(
      `${dashboardOrigin}/api/dashboard/projects/${id}${method === "RESTORE" ? "/restore" : ""}`,
      {
        method: method === "RESTORE" ? "POST" : method,
        headers: {
          Origin: dashboardOrigin,
          "Content-Type": "application/json",
          Cookie: cookie,
          ...overrides,
        },
        body: JSON.stringify(data),
      },
    ),
    { params: Promise.resolve({ id }) },
  );
}

it("updates project settings atomically and applies origins without rotating the DSN", async () => {
  const { id, dsn } = await (await create(["http://localhost:8080"])).json();
  const before = await web.project.findUniqueOrThrow({
    where: { id },
    include: { keys: true, teams: true },
  });
  const data = {
    name: "New account name",
    slug: "renamed-account",
    origins: [
      "https://app.example.test/",
      "https://app.example.test",
      "http://localhost:3000",
    ],
  };

  expect((await change(id, "PATCH", data)).status).toBe(200);
  const updated = await web.project.findUniqueOrThrow({
    where: { id },
    include: { origins: true, keys: true, teams: true },
  });

  expect(updated.name).toBe(data.name);
  expect(updated.slug).toBe(data.slug);
  expect(updated.origins.map((entry) => entry.origin).sort()).toEqual([
    "http://localhost:3000",
    "https://app.example.test",
  ]);
  expect(updated.keys).toEqual(before.keys);
  expect(updated.teams).toEqual(before.teams);
  expect(updated.keys[0]!.keyHash).toBe(digest(new URL(dsn).username));
  expect(
    await ingest.ingestionConfig.count({
      where: { projectId: id, origin: "http://localhost:8080" },
    }),
  ).toBe(0);
  expect(
    await ingest.ingestionConfig.count({
      where: { projectId: id, origin: "http://localhost:3000" },
    }),
  ).toBe(1);

  for (const origins of [
    [],
    ["https://*.example.test"],
    ["http://example.test"],
    Array.from(
      { length: 21 },
      (_, index) => `https://app${index}.example.test`,
    ),
  ]) {
    expect(
      (
        await change(id, "PATCH", {
          ...data,
          name: "Must not be saved",
          origins,
        })
      ).status,
    ).toBe(400);
  }

  const other = await (await create(["https://other.example.test"])).json();

  expect((await change(other.id, "PATCH", data)).status).toBe(409);
  expect((await change(id, "PATCH", { ...data, enabled: false })).status).toBe(
    400,
  );
  expect(
    (
      await web.project.findUniqueOrThrow({
        where: { id },
        include: { origins: true },
      })
    ).origins,
  ).toEqual(updated.origins);
  expect(
    await web.auditLog.count({
      where: { action: "project_update", success: true },
    }),
  ).toBe(1);
});

it("requires Owner, CSRF protection, fresh TOTP and exact confirmation for lifecycle mutations", async () => {
  const { id } = await (await create(["https://access.example.test"])).json();
  const project = await web.project.findUniqueOrThrow({ where: { id } });
  const member = await web.member.findFirstOrThrow({
    where: { role: "owner" },
  });
  const update = {
    name: project.name,
    slug: project.slug,
    origins: ["https://access.example.test"],
  };
  const operations = [
    ["PATCH", update],
    ["DELETE", { slug: project.slug }],
    ["RESTORE", {}],
  ] as const;

  for (const [method, data] of operations) {
    expect((await change(id, method, data, { Cookie: "" })).status).toBe(401);
    expect(
      (
        await change(id, method, data, {
          Origin: "https://attacker.example.test",
        })
      ).status,
    ).toBe(403);
    expect(
      (await change(id, method, data, { "Content-Type": "text/plain" })).status,
    ).toBe(403);
  }

  try {
    for (const role of ["developer", "viewer"]) {
      await database.admin.member.update({
        where: { id: member.id },
        data: { role },
      });

      for (const [method, data] of operations) {
        expect((await change(id, method, data)).status).toBe(403);
      }
    }
  } finally {
    await database.admin.member.update({
      where: { id: member.id },
      data: { role: "owner" },
    });
  }

  await database.admin.session.updateMany({
    data: { mfaVerifiedAt: new Date(Date.now() - 301_000) },
  });

  for (const [method, data] of operations) {
    expect((await change(id, method, data)).status).toBe(428);
  }

  await runtime.service.stepUp(
    new Headers({ Cookie: cookie }),
    {
      password: ownerPassword,
      code: totp(ownerSecret, BigInt(Math.floor(Date.now() / 30_000)) + 1n),
      trustDevice: false,
    },
    "project-test",
  );
  expect((await change(id, "PATCH", update)).status).toBe(200);
  expect((await change(id, "DELETE", { slug: "wrong-slug" })).status).toBe(400);
  expect(
    (await change(randomUUID(), "DELETE", { slug: project.slug })).status,
  ).toBe(404);
  expect(
    (await web.project.findUniqueOrThrow({ where: { id } })).deletedAt,
  ).toBeNull();
});

it("disables ingestion, preserves recoverable data, restores the same DSN and purges only expired projects", async () => {
  const { id, dsn } = await (
    await create(["https://lifecycle.example.test"])
  ).json();
  const preserved = await (await create(["https://keep.example.test"])).json();
  const project = await web.project.findUniqueOrThrow({
    where: { id },
    include: { keys: true, origins: true, teams: true },
  });
  const activeMember = await web.member.findFirstOrThrow({
    where: { role: "owner" },
  });
  const eventId = randomUUID().replaceAll("-", "");

  await database.admin.eventInbox.create({
    data: {
      projectId: id,
      eventId,
      payload: JSON.parse(
        JSON.stringify(
          sanitizeEvent(
            { message: "Lifecycle test", release: "account@" + "a".repeat(40) },
            eventId,
          ),
        ),
      ),
    },
  });

  while (await runOne(worker)) {
    // Drain the isolated test queue so lifecycle assertions include processed events.
  }

  const counts = () =>
    Promise.all([
      database.admin.errorEvent.count({ where: { projectId: id } }),
      database.admin.issue.count({ where: { projectId: id } }),
      database.admin.release.count({ where: { projectId: id } }),
      database.admin.eventInbox.count({ where: { projectId: id } }),
      database.admin.projectDailyStat.count({ where: { projectId: id } }),
      database.admin.projectIngestionKey.count({ where: { projectId: id } }),
      database.admin.projectOrigin.count({ where: { projectId: id } }),
      database.admin.projectTeam.count({ where: { projectId: id } }),
    ]);
  const before = await counts();

  expect(before.every((count) => count > 0)).toBe(true);
  expect((await change(id, "DELETE", { slug: project.slug })).status).toBe(200);
  const deleted = await web.project.findUniqueOrThrow({ where: { id } });

  expect(deleted.enabled).toBe(false);
  expect(deleted.deletedAt).not.toBeNull();
  expect(await ingest.ingestionConfig.count({ where: { projectId: id } })).toBe(
    0,
  );
  expect(
    await web.project.count({ where: { id, ...projectScope(activeMember) } }),
  ).toBe(0);
  expect(await counts()).toEqual(before);
  expect(await purgeDeletedProjectBatch(worker)).toBe(0);
  expect((await change(id, "DELETE", { slug: project.slug })).status).toBe(404);
  expect(
    (
      await change(id, "PATCH", {
        name: "Deleted",
        slug: project.slug,
        origins: ["https://lifecycle.example.test"],
      })
    ).status,
  ).toBe(404);
  expect(
    (await web.project.findUniqueOrThrow({ where: { id } })).deletedAt,
  ).toEqual(deleted.deletedAt);

  const server = createIngestServer(ingest, { origin: ingestOrigin });

  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("Missing test listener");
  }

  const send = () =>
    fetch(
      `http://127.0.0.1:${address.port}/api/${id}/envelope/?sentry_key=${new URL(dsn).username}`,
      {
        method: "POST",
        headers: {
          Origin: "https://lifecycle.example.test",
          "Content-Type": "application/x-sentry-envelope",
        },
        body: encodeEnvelope(
          sanitizeEvent(
            { message: "Restored project" },
            randomUUID().replaceAll("-", ""),
          ),
        ),
      },
    );

  try {
    expect((await send()).status).toBe(403);
    expect((await change(id, "RESTORE", {})).status).toBe(200);
    expect(await counts()).toEqual(before);
    const restored = await web.project.findUniqueOrThrow({
      where: { id },
      include: { keys: true, teams: true },
    });

    expect(restored.keys).toEqual(project.keys);
    expect(restored.teams).toEqual(project.teams);
    expect(restored.enabled).toBe(true);
    expect(restored.deletedAt).toBeNull();
    expect((await send()).status).toBe(200);
    expect((await change(id, "DELETE", { slug: project.slug })).status).toBe(
      200,
    );
    expect(await claim(worker)).toBeNull();
  } finally {
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  // Runtime roles cannot force the final cleanup of an active or recoverable project.
  await expect(purgeDeletedProjectBatch(web)).rejects.toThrow();
  await expect(
    worker.project.delete({ where: { id: preserved.id } }),
  ).rejects.toThrow();
  await database.admin.project.update({
    where: { id },
    data: { deletedAt: new Date(Date.now() - 7 * 86400_000 - 1000) },
  });
  expect((await change(id, "RESTORE", {})).status).toBe(409);

  const stored = await database.admin.errorEvent.findFirstOrThrow({
    where: { projectId: id },
  });

  await database.admin.errorEvent.createMany({
    data: Array.from({ length: 500 }, () => ({
      ...stored,
      id: randomUUID(),
      eventId: randomUUID().replaceAll("-", ""),
      frames: [],
      tags: {},
      breadcrumbs: [],
    })),
  });
  expect(await purgeDeletedProjectBatch(worker)).toBe(500);
  expect(
    await database.admin.errorEvent.count({ where: { projectId: id } }),
  ).toBe(1);
  expect(await web.project.count({ where: { id } })).toBe(1);

  for (
    let batch = 0;
    batch < 10 && (await purgeDeletedProjectBatch(worker));
    batch++
  ) {
    // Cleanup uses bounded transactions; drain them as the retention loop would.
  }

  expect(await web.project.count({ where: { id } })).toBe(0);
  expect(await counts()).toEqual(Array(8).fill(0));
  expect(await web.project.count({ where: { id: preserved.id } })).toBe(1);
  expect(await web.user.count()).toBe(1);
  expect(await web.team.count()).toBe(1);
  expect(
    await web.auditLog.count({
      where: { action: "project_delete", success: true },
    }),
  ).toBe(2);
  expect(
    await web.auditLog.count({
      where: { action: "project_restore", success: true },
    }),
  ).toBe(1);
  expect(
    await web.auditLog.count({
      where: { action: "project_purge", success: true },
    }),
  ).toBe(1);
});

it("does not let a deleted project's pending backlog block active projects", async () => {
  const deleted = await (await create(["https://backlog.example.test"])).json();
  const active = await (await create(["https://active.example.test"])).json();
  const project = await web.project.findUniqueOrThrow({
    where: { id: deleted.id },
  });

  // Seed a full queue directly in the isolated admin database; never bypass admission in runtime code.
  await database.admin.$transaction(async (tx) => {
    await tx.$executeRaw`SET LOCAL session_replication_role = replica`;
    await tx.$executeRaw`INSERT INTO event_inbox (id, "projectId", "eventId", payload)
      SELECT gen_random_uuid()::text, ${deleted.id}, md5(series::text), '{}'::jsonb
      FROM generate_series(1, 10000) series`;
  });
  const insert = () => {
    const eventId = randomUUID().replaceAll("-", "");

    return database.admin.eventInbox.create({
      data: {
        projectId: active.id,
        eventId,
        payload: JSON.parse(
          JSON.stringify(
            sanitizeEvent({ message: "Admission remains available" }, eventId),
          ),
        ),
      },
    });
  };

  try {
    await expect(insert()).rejects.toThrow();
    expect(
      (await change(deleted.id, "DELETE", { slug: project.slug })).status,
    ).toBe(200);
    await expect(insert()).resolves.toMatchObject({ projectId: active.id });
  } finally {
    await database.admin.project.deleteMany({
      where: { id: { in: [deleted.id, active.id] } },
    });
  }
});
