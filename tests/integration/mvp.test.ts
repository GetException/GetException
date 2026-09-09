import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import pg from "pg";
import {
  createDatabase,
  createIngestDatabase,
  type IngestDatabase,
  type Database,
  assertSchema,
} from "@getexception/db";
import { sanitizeEvent } from "@getexception/protocol";
import { AuthService } from "../../apps/web/src/server/auth-service";
import { createRuntime } from "../../apps/web/src/server/runtime";
import { changeIssueStatus } from "../../apps/web/src/server/issue-workflow";
import { issueFilters, issueWhere } from "../../apps/web/src/server/filters";
import { json } from "../../apps/web/src/server/http";
import {
  digest,
  decryptSecret,
  token,
  totp,
} from "../../apps/web/src/server/crypto";
import {
  createIngestServer,
  inboxReadiness,
} from "../../apps/ingest/src/server";
import {
  claim,
  processJob,
  retryJob,
  runOne,
  retainBatch,
} from "../../apps/worker/src/events";
import { temporaryDatabase, migrationFiles } from "./database";

let instance: Awaited<ReturnType<typeof temporaryDatabase>>;
let web: Database,
  ingest: IngestDatabase,
  worker: Database,
  secondWorker: Database,
  service: AuthService;
const password = randomBytes(24).toString("base64url");
const email = "owner@example.test";
const period = () => BigInt(Math.floor(Date.now() / 30_000));
let encryptionKey: string;

beforeAll(async () => {
  instance = await temporaryDatabase();
  web = createDatabase(instance.urls.web);
  ingest = createIngestDatabase(instance.urls.ingest);
  worker = createDatabase(instance.urls.worker);
  secondWorker = createDatabase(instance.urls.worker);
  encryptionKey = token();
  service = new AuthService(web, {
    DATABASE_URL: instance.urls.web,
    DASHBOARD_ORIGIN: "https://monitor.localhost",
    INGEST_ORIGIN: "https://ingest.monitor.localhost",
    TOTP_ENCRYPTION_KEY: encryptionKey,
    AUTH_RATE_KEY: token(),
    MAIL_ENCRYPTION_KEY: token(),
    BETTER_AUTH_SECRET: token(),
  });
});
afterAll(async () => {
  await Promise.all(
    [web, ingest, worker, secondWorker]
      .filter(Boolean)
      .map((db) => db.$disconnect()),
  );
  await instance?.cleanup();
});
beforeEach(async () => {
  await instance.admin.organization.deleteMany();
  await instance.admin.user.deleteMany();
  await instance.admin.systemSetting.deleteMany();
  await instance.admin.bootstrapToken.deleteMany();
  await instance.admin.setupSession.deleteMany();
  await instance.admin.auditLog.deleteMany();
  await instance.admin.authRateBucket.deleteMany();
});

async function pendingSetup() {
  const bootstrap = token();

  await instance.admin.bootstrapToken.create({
    data: {
      tokenHash: digest(bootstrap),
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const access = await service.setupAccess(bootstrap, "local-test");
  const pending = await service.prepareSetup(
    access,
    { email, password, domain: "monitor.localhost" },
    "local-test",
  );

  return { access, pending, bootstrap };
}

async function installed() {
  const data = await pendingSetup();
  // Accept the previous valid window so a current code is immediately available for login tests.
  // Pin Date.now during setup so that window cannot expire while database requests are in flight.
  const clock = vi.spyOn(Date, "now").mockReturnValue(Date.now());

  try {
    const result = await service.finishSetup(
      data.access,
      totp(data.pending.secret, period() - 1n),
      "local-test",
    );

    return { ...data, ...result };
  } finally {
    clock.mockRestore();
  }
}

async function project() {
  const workspace = await instance.admin.organization.create({
    data: { id: randomUUID(), name: "Test", slug: "test" },
  });

  await instance.admin.systemSetting.create({
    data: { domain: "monitor.localhost" },
  });
  const key = token();
  const project = await instance.admin.project.create({
    data: {
      organizationId: workspace.id,
      name: "Browser",
      slug: "browser",
      keys: { create: { keyHash: digest(key) } },
      origins: { create: { origin: "https://browser.monitor.localhost" } },
    },
  });

  return { project, key };
}

async function insert(
  projectId: string,
  eventId = randomBytes(16).toString("hex"),
) {
  const event = sanitizeEvent(
    {
      message: "Integration error",
      exception: {
        values: [
          {
            type: "Error",
            value: "Integration error",
            stacktrace: {
              frames: [
                {
                  filename: "https://app.example.com/app.js",
                  function: "render",
                  lineno: 1,
                },
              ],
            },
          },
        ],
      },
    },
    eventId,
  );

  await ingest.eventInbox.createMany({
    data: { id: randomUUID(), projectId, eventId, payload: event },
    skipDuplicates: true,
  });

  return event;
}

describe("atomic setup and MFA", () => {
  it("does not create a permanent Account or credential before TOTP confirmation", async () => {
    const { access, pending } = await pendingSetup();
    const row = await web.setupSession.findFirstOrThrow();

    expect(await web.user.count()).toBe(0);
    expect(await web.mfaCredential.count()).toBe(0);
    expect(row.pendingCiphertext.includes(pending.secret)).toBe(false);
    expect(
      decryptSecret(
        row.pendingCiphertext,
        row.userId,
        "pending",
        encryptionKey,
      ) === pending.secret,
    ).toBe(true);
    expect(() =>
      decryptSecret(row.pendingCiphertext, row.userId, "active", encryptionKey),
    ).toThrow();
    expect(() =>
      decryptSecret(
        row.pendingCiphertext,
        randomUUID(),
        "pending",
        encryptionKey,
      ),
    ).toThrow();
    await expect(
      service.finishSetup(access, "invalid", "local-test"),
    ).rejects.toThrow();
    expect(await web.user.count()).toBe(0);
  });
  it("atomically creates exactly one root and blocks concurrent and repeated setup", async () => {
    const { access, pending, bootstrap } = await pendingSetup();
    const code = totp(pending.secret, period());
    const results = await Promise.allSettled([
      service.finishSetup(access, code, "one"),
      service.finishSetup(access, code, "two"),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await web.user.count()).toBe(1);
    expect(await web.member.count({ where: { role: "owner" } })).toBe(1);
    expect(await web.organization.count()).toBe(1);
    expect(await web.bootstrapToken.count()).toBe(0);
    expect(await web.setupSession.count()).toBe(0);
    const credential = await web.mfaCredential.findFirstOrThrow();

    expect(credential.state).toBe("active");
    expect(
      decryptSecret(
        credential.ciphertext,
        credential.userId,
        "active",
        encryptionKey,
      ) === pending.secret,
    ).toBe(true);
    expect(
      (await web.recoveryCode.findMany()).every((row) =>
        /^[a-f0-9]{64}$/.test(row.codeHash),
      ),
    ).toBe(true);
    await expect(service.setupAccess(bootstrap, "three")).rejects.toThrow();
  });
  it("rolls back all setup changes when final persistence fails", async () => {
    const { access, pending } = await pendingSetup();

    await instance.admin.user.create({
      data: { id: randomUUID(), email, name: "Conflicting test account" },
    });
    await expect(
      service.finishSetup(access, totp(pending.secret, period()), "local-test"),
    ).rejects.toThrow();
    expect(await web.systemSetting.count()).toBe(0);
    expect(await web.organization.count()).toBe(0);
    expect(await web.mfaCredential.count()).toBe(0);
    expect(await web.bootstrapToken.count()).toBe(1);
  });
  it("accepts one concurrent login and prevents replay in sessions and step-up", async () => {
    const data = await installed();
    const code = totp(data.pending.secret, period());
    const body = { email, password, code, trustDevice: false };
    const results = await Promise.allSettled([
      service.login(body, "one"),
      service.login(body, "two"),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    expect(await web.session.count()).toBe(1);
    expect((await web.session.findFirstOrThrow()).mfaVerifiedAt).not.toBeNull();
    await expect(service.login(body, "three")).rejects.toThrow();
    const audit = JSON.stringify(await web.auditLog.findMany());

    expect(
      [password, data.pending.secret, code, ...data.recoveryCodes].some(
        (secret) => audit.includes(secret),
      ),
    ).toBe(false);
  });
  it("consumes recovery codes once and rejects trusted-device and email OTP", async () => {
    const data = await installed();

    await expect(
      service.login(
        {
          email,
          password,
          code: totp(data.pending.secret, period()),
          trustDevice: true,
        },
        "test",
      ),
    ).rejects.toThrow();
    await expect(
      service.login(
        { email, password, emailOtp: "123456", trustDevice: false },
        "test",
      ),
    ).rejects.toThrow();
    const body = {
      email,
      password,
      recoveryCode: data.recoveryCodes[0],
      trustDevice: false,
    };

    await service.login(body, "one");
    await expect(service.login(body, "two")).rejects.toThrow();
  });
  it("uses Better Auth cookies, requires fresh TOTP after recovery and serializes step-up", async () => {
    const data = await installed();
    const runtime = createRuntime(service.config, web);
    const response = await runtime.auth.handler(
      new Request(service.config.DASHBOARD_ORIGIN + "/api/auth/owner/login", {
        method: "POST",
        headers: {
          Origin: service.config.DASHBOARD_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email,
          password,
          recoveryCode: data.recoveryCodes[0],
          trustDevice: false,
        }),
      }),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get("cache-control")).toBe("no-store");
    const cookie = response.headers.get("set-cookie")!;

    expect(cookie.includes("HttpOnly")).toBe(true);
    expect(cookie.includes("Secure")).toBe(true);
    expect(cookie.includes("Domain=")).toBe(false);
    const headers = new Headers({ Cookie: cookie.split(";")[0]! });

    await expect(service.authorize(headers)).resolves.toBeDefined();
    await expect(service.authorize(headers, true)).rejects.toMatchObject({
      status: 428,
    });
    const input = {
      password,
      code: totp(data.pending.secret, period()),
      trustDevice: false,
    };
    const results = await Promise.allSettled([
      service.stepUp(headers, input, "one"),
      service.stepUp(headers, input, "two"),
    ]);

    expect(
      results.filter((result) => result.status === "fulfilled"),
    ).toHaveLength(1);
    await expect(service.authorize(headers, true)).resolves.toBeDefined();
    await expect(service.login({ email, ...input }, "three")).rejects.toThrow();
    await web.session.updateMany({
      data: { mfaVerifiedAt: new Date(Date.now() - 301_000) },
    });
    await expect(service.authorize(headers, true)).rejects.toMatchObject({
      status: 428,
    });
    expect(json({ ok: true }).headers.get("cache-control")).toBe("no-store");
  });
  it("rolls back TOTP consumption when Better Auth session creation fails inside its request context", async () => {
    const data = await installed();
    const runtime = createRuntime(service.config, web);
    const admin = new pg.Client({ connectionString: instance.adminUrl });

    await admin.connect();
    const credential = await web.mfaCredential.findFirstOrThrow();
    const input = {
      email,
      password,
      code: totp(data.pending.secret, period()),
      trustDevice: false,
    };
    const request = () =>
      new Request(service.config.DASHBOARD_ORIGIN + "/api/auth/owner/login", {
        method: "POST",
        headers: {
          Origin: service.config.DASHBOARD_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify(input),
      });

    try {
      await admin.query(
        "CREATE FUNCTION test_reject_session() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test_persistence_failure'; END $$",
      );
      await admin.query(
        "CREATE TRIGGER test_reject BEFORE INSERT ON session FOR EACH ROW EXECUTE FUNCTION test_reject_session()",
      );
      expect((await runtime.auth.handler(request())).status).toBe(401);
      expect(await web.session.count()).toBe(0);
      expect((await web.mfaCredential.findFirstOrThrow()).lastCounter).toBe(
        credential.lastCounter,
      );
    } finally {
      await admin.query("DROP TRIGGER IF EXISTS test_reject ON session");
      await admin.query("DROP FUNCTION IF EXISTS test_reject_session()");
      await admin.end();
    }

    expect((await runtime.auth.handler(request())).status).toBe(200);
    expect(await web.session.count()).toBe(1);
  });
  it("shares rate limits across replicas and stores hashed identifiers only", async () => {
    const second = new AuthService(web, service.config);

    for (let index = 0; index < 10; index++) {
      await (index % 2 ? service : second).rateLimit(
        "test-ip",
        "Mixed@Example.test",
        "shared",
      );
    }

    await expect(
      second.rateLimit("another-ip", "mixed@example.test", "shared"),
    ).rejects.toMatchObject({ status: 429 });
    await expect(
      service.rateLimit("test-ip", "another@example.test", "shared"),
    ).rejects.toMatchObject({ status: 429 });
    const rows = await web.authRateBucket.findMany();

    expect(rows.every((row) => /^[a-f0-9]{64}$/.test(row.id))).toBe(true);
  });
});
describe("durable inbox and separate SQL roles", () => {
  it("returns 503 without acknowledging events when PostgreSQL is unavailable", async () => {
    const { project: p, key } = await project();
    const offlineUrl = new URL(instance.urls.ingest);

    offlineUrl.port = "1";
    const offline = createIngestDatabase(offlineUrl.toString());
    const server = createIngestServer(offline, {
      origin: "https://ingest.monitor.localhost",
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("No port");
    }

    const origin = `http://127.0.0.1:${address.port}`;

    try {
      expect((await fetch(origin + "/health/live")).status).toBe(200);
      expect((await fetch(origin + "/health/ready")).status).toBe(503);
      expect(
        (
          await fetch(origin + `/api/${p.id}/envelope/?sentry_key=${key}`, {
            method: "POST",
            headers: {
              "Content-Type": "application/x-sentry-envelope",
              Origin: "https://browser.monitor.localhost",
            },
            body: '{}\n{"type":"event"}\n{}',
          })
        ).status,
      ).toBe(503);
      expect(await instance.admin.eventInbox.count()).toBe(0);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      await offline.$disconnect();
    }
  });
  it("checks actual inbox writes in a rolled-back readiness probe", async () => {
    await assertSchema(ingest);
    await inboxReadiness(ingest);
    expect(await instance.admin.eventInbox.count()).toBe(0);
    const denied = createDatabase(instance.urls.ingest);

    await expect(denied.user.findMany()).rejects.toThrow();
    await expect(denied.session.findMany()).rejects.toThrow();
    await expect(denied.errorEvent.findMany()).rejects.toThrow();
    await expect(ingest.eventInbox.findMany()).rejects.toThrow();
    await expect(worker.user.findMany()).rejects.toThrow();
    await expect(web.auditLog.deleteMany()).rejects.toThrow();
    await denied.$disconnect();
  });
  it("acknowledges HTTP only after sanitized durable insert, checks Origin and rejects duplicates", async () => {
    const { project: p, key } = await project();
    const server = createIngestServer(ingest, {
      origin: "https://ingest.monitor.localhost",
    });

    await new Promise<void>((resolve) =>
      server.listen(0, "127.0.0.1", resolve),
    );
    const address = server.address();

    if (!address || typeof address === "string") {
      throw new Error("No port");
    }

    const url = `http://127.0.0.1:${address.port}/api/${p.id}/envelope/?sentry_key=${key}`;
    const eventId = randomBytes(16).toString("hex"),
      canary = token();
    const raw = {
      event_id: eventId,
      message: "Integration error",
      request: { cookies: canary, headers: { authorization: canary } },
      contexts: { arbitrary: { canary } },
    };
    const envelope =
      JSON.stringify({ event_id: eventId }) +
      '\n{"type":"event"}\n' +
      JSON.stringify(raw);

    try {
      const request = {
        method: "POST",
        headers: {
          "Content-Type": "application/x-sentry-envelope",
          Origin: "https://browser.monitor.localhost",
        },
        body: envelope,
      };
      const response = await fetch(url, request);

      expect(response.status).toBe(200);
      expect(
        response.headers.get("access-control-allow-credentials"),
      ).toBeNull();
      const row = await instance.admin.eventInbox.findFirstOrThrow();

      expect(JSON.stringify(row.payload).includes(canary)).toBe(false);
      expect(row.receivedAt.getTime()).toBeLessThanOrEqual(Date.now());
      expect((await fetch(url, request)).status).toBe(200);
      expect(await instance.admin.eventInbox.count()).toBe(1);
      expect(
        (
          await fetch(url, {
            ...request,
            headers: { ...request.headers, Origin: "https://evil.test" },
          })
        ).status,
      ).toBe(403);
      expect(
        (
          await fetch(url, {
            ...request,
            headers: { ...request.headers, "Content-Encoding": "gzip" },
          })
        ).status,
      ).toBe(415);
      expect(
        (
          await fetch(url, {
            ...request,
            body: envelope + '\n{"type":"event"}\n{}',
          })
        ).status,
      ).toBe(400);
      await web.project.update({
        where: { id: p.id },
        data: { dailyQuota: 1 },
      });
      const nextId = randomBytes(16).toString("hex");

      expect(
        (
          await fetch(url, {
            ...request,
            body: envelope.replaceAll(eventId, nextId),
          })
        ).status,
      ).toBe(429);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  });
  it("enforces admission quotas transactionally across ingest connections", async () => {
    const { project: p } = await project();

    await web.project.update({ where: { id: p.id }, data: { dailyQuota: 1 } });
    await insert(p.id);
    await expect(insert(p.id)).rejects.toThrow();
    expect(await instance.admin.eventInbox.count()).toBe(1);
  });
  it("processes two replicas without duplicate events or counters and fences stale leases", async () => {
    const { project: p } = await project();

    for (let n = 0; n < 8; n++) {
      await insert(p.id);
    }

    await Promise.all(
      [
        async () => {
          while (await runOne(worker)) {
            /* Drain one replica. */
          }
        },
        async () => {
          while (await runOne(secondWorker)) {
            /* Drain the other replica. */
          }
        },
      ].map((fn) => fn()),
    );
    expect(await instance.admin.errorEvent.count()).toBe(8);
    expect(await instance.admin.issue.count()).toBe(1);
    expect((await instance.admin.issue.findFirstOrThrow()).eventCount).toBe(8);
    const event = await insert(p.id);
    const stale = await claim(worker);

    expect(stale).not.toBeNull();
    await instance.admin.eventInbox.update({
      where: { id: stale!.id },
      data: { leaseUntil: new Date(0) },
    });
    const renewed = await claim(secondWorker);

    await processJob(worker, stale!);
    expect(await instance.admin.errorEvent.count()).toBe(8);
    await processJob(secondWorker, renewed!);
    await ingest.eventInbox.createMany({
      data: {
        id: randomUUID(),
        projectId: p.id,
        eventId: event.eventId,
        payload: event,
      },
      skipDuplicates: true,
    });
    expect(await runOne(worker)).toBe(false);
    expect(await instance.admin.errorEvent.count()).toBe(9);
  });
  it("retries poisoned records with bounded backoff and dead letters", async () => {
    const { project: p } = await project();

    await insert(p.id);
    const row = await instance.admin.eventInbox.findFirstOrThrow();

    await instance.admin.eventInbox.update({
      where: { id: row.id },
      data: { payload: {} },
    });

    for (let n = 0; n < 5; n++) {
      const job = await claim(worker);

      expect(job).not.toBeNull();
      await expect(processJob(worker, job!)).rejects.toThrow();
      await retryJob(worker, job!);
      const updated = await instance.admin.eventInbox.findUniqueOrThrow({
        where: { id: row.id },
      });

      expect(updated.attempts).toBe(n + 1);
      expect(updated.nextAttemptAt.getTime()).toBeGreaterThan(Date.now());
      await instance.admin.eventInbox.update({
        where: { id: row.id },
        data: { nextAttemptAt: new Date(0) },
      });
    }

    expect(
      (
        await instance.admin.eventInbox.findUniqueOrThrow({
          where: { id: row.id },
        })
      ).status,
    ).toBe("dead");
    expect(await claim(worker)).toBeNull();
  });
  it("retains group aggregates while deleting old events in bounded batches", async () => {
    const { project: p } = await project();

    await insert(p.id);
    await runOne(worker);
    await instance.admin.errorEvent.updateMany({
      data: { receivedAt: new Date(0) },
    });
    expect(await retainBatch(worker)).toBe(1);
    expect(await instance.admin.issue.count()).toBe(1);
    expect(
      await instance.admin.eventInbox.count({ where: { status: "done" } }),
    ).toBe(1);
  });
  it("applies the next migration on an existing previous schema without data loss", async () => {
    const client = new pg.Client({ connectionString: instance.adminUrl });

    await client.connect();
    await client.query("CREATE DATABASE getexception_upgrade_test");
    const url = new URL(instance.adminUrl);

    url.pathname = "/getexception_upgrade_test";
    const upgrade = new pg.Client({ connectionString: url.toString() });

    await upgrade.connect();

    try {
      const [initial, boundaries, workflow, invitations] = migrationFiles();

      await upgrade.query(initial!);
      await upgrade.query(
        "CREATE TABLE _prisma_migrations (finished_at timestamptz, rolled_back_at timestamptz)",
      );
      await upgrade.query(
        "INSERT INTO system_setting(id,domain) VALUES (1,$1)",
        ["existing.example.test"],
      );
      await upgrade.query(boundaries!);
      expect(
        (
          await upgrade.query(
            "SELECT has_column_privilege('getexception_web', 'issue', 'status', 'UPDATE') AS allowed",
          )
        ).rows[0]?.allowed,
      ).toBe(false);
      await upgrade.query(
        "INSERT INTO _prisma_migrations(finished_at) VALUES (now()), (now())",
      );
      await upgrade.query(workflow!);
      expect(
        (await upgrade.query("SELECT version FROM runtime_schema")).rowCount,
      ).toBe(0);
      await upgrade.query(
        "INSERT INTO _prisma_migrations(finished_at) VALUES (now())",
      );
      expect(
        (await upgrade.query("SELECT version FROM runtime_schema")).rows[0]
          ?.version,
      ).toBe(2);
      await upgrade.query(invitations!);
      expect(
        (await upgrade.query("SELECT version FROM runtime_schema")).rowCount,
      ).toBe(0);
      await upgrade.query(
        "INSERT INTO _prisma_migrations(finished_at) VALUES (now())",
      );
      expect(
        (await upgrade.query("SELECT version FROM runtime_schema")).rows[0]
          ?.version,
      ).toBe(3);
      expect(
        (await upgrade.query("SELECT count(*) FROM invitation")).rows[0]?.count,
      ).toBe("0");
      expect(
        (
          await upgrade.query(
            "SELECT has_column_privilege('getexception_web', 'issue', 'status', 'UPDATE') AS allowed",
          )
        ).rows[0]?.allowed,
      ).toBe(true);
      expect(
        (
          await upgrade.query(
            "SELECT has_column_privilege('getexception_web', 'issue', 'eventCount', 'UPDATE') AS allowed",
          )
        ).rows[0]?.allowed,
      ).toBe(false);
      expect(
        (await upgrade.query("SELECT domain FROM system_setting")).rows[0]
          ?.domain,
      ).toBe("existing.example.test");
    } finally {
      await upgrade.end();
      await client.query("DROP DATABASE getexception_upgrade_test");
      await client.end();
    }
  });
});

async function workflowSession() {
  const data = await installed();
  const runtime = createRuntime(service.config, web);
  const response = await runtime.auth.handler(
    new Request(service.config.DASHBOARD_ORIGIN + "/api/auth/owner/login", {
      method: "POST",
      headers: {
        Origin: service.config.DASHBOARD_ORIGIN,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        email,
        password,
        recoveryCode: data.recoveryCodes[0],
        trustDevice: false,
      }),
    }),
  );

  expect(response.status).toBe(200);
  const headers = new Headers({
    Cookie: response.headers.get("set-cookie")!.split(";")[0]!,
  });
  const member = await web.member.findFirstOrThrow();
  const p = await web.project.create({
    data: {
      organizationId: member.organizationId,
      name: "Workflow",
      slug: "workflow",
    },
  });

  await insert(p.id);
  await runOne(worker);
  const issue = await web.issue.findFirstOrThrow();

  return { headers, member, project: p, issue };
}

describe("issue investigation workflow", () => {
  it("enforces authentication, workspace scope and limited write permissions", async () => {
    const { headers, member, issue } = await workflowSession();
    const input = { status: "resolved", eventCount: 1 };

    await expect(
      changeIssueStatus(service, new Headers(), issue.id, input),
    ).rejects.toMatchObject({ status: 401 });
    await expect(
      changeIssueStatus(service, headers, randomUUID(), input),
    ).rejects.toMatchObject({ status: 404 });
    expect(
      await web.issue.count({
        where: issueWhere(
          { id: member.id, role: "owner", organizationId: randomUUID() },
          issueFilters({ project: issue.projectId }),
        ),
      }),
    ).toBe(0);
    expect(
      await web.issue.count({
        where: issueWhere(member, issueFilters({ project: randomUUID() })),
      }),
    ).toBe(0);
    await expect(
      web.issue.update({ where: { id: issue.id }, data: { eventCount: 50 } }),
    ).rejects.toThrow();
    await expect(
      web.issue.update({ where: { id: issue.id }, data: { title: "forged" } }),
    ).rejects.toThrow();
    await expect(
      changeIssueStatus(service, headers, issue.id, {
        ...input,
        title: "forged",
      }),
    ).rejects.toThrow();
    await web.member.update({
      where: { id: member.id },
      data: { active: false },
    });
    await expect(
      changeIssueStatus(service, headers, issue.id, input),
    ).rejects.toMatchObject({ status: 403 });
    expect(
      (await web.issue.findUniqueOrThrow({ where: { id: issue.id } })).status,
    ).toBe("open");
  });
  it("resolves and reopens with atomic audit records and rejects stale event counts", async () => {
    const { headers, issue, project } = await workflowSession();

    await changeIssueStatus(service, headers, issue.id, {
      status: "resolved",
      eventCount: 1,
    });
    expect(
      (await web.issue.findUniqueOrThrow({ where: { id: issue.id } })).status,
    ).toBe("resolved");
    await changeIssueStatus(service, headers, issue.id, {
      status: "resolved",
      eventCount: 1,
    });
    expect(
      await web.auditLog.count({ where: { action: "issue_resolve" } }),
    ).toBe(1);
    await changeIssueStatus(service, headers, issue.id, {
      status: "open",
      eventCount: 1,
    });
    expect(
      await web.auditLog.count({ where: { action: "issue_reopen" } }),
    ).toBe(1);
    await changeIssueStatus(service, headers, issue.id, {
      status: "resolved",
      eventCount: 1,
    });
    await insert(project.id);
    await runOne(worker);
    expect(
      await web.issue.findUniqueOrThrow({ where: { id: issue.id } }),
    ).toMatchObject({ status: "open", regression: true, eventCount: 2 });
    await expect(
      changeIssueStatus(service, headers, issue.id, {
        status: "resolved",
        eventCount: 1,
      }),
    ).rejects.toMatchObject({ status: 409 });
    expect(
      await web.issue.count({
        where: issueWhere(
          {
            id: randomUUID(),
            role: "owner",
            organizationId: project.organizationId,
          },
          issueFilters({ status: "regression" }),
        ),
      }),
    ).toBe(1);
    await changeIssueStatus(service, headers, issue.id, {
      status: "resolved",
      eventCount: 2,
    });
    expect(
      await web.issue.findUniqueOrThrow({ where: { id: issue.id } }),
    ).toMatchObject({ status: "resolved", regression: false });
  });
  it("detects regression when a worker update waits behind a concurrent resolve", async () => {
    const { issue } = await workflowSession();
    const writer = new pg.Client({ connectionString: instance.urls.web });
    const consumer = new pg.Client({ connectionString: instance.urls.worker });

    await Promise.all([writer.connect(), consumer.connect()]);

    try {
      const consumerPid = (
        await consumer.query("SELECT pg_backend_pid() AS pid")
      ).rows[0].pid as number;

      await writer.query("BEGIN");
      await writer.query(
        "UPDATE issue SET status='resolved', regression=false WHERE id=$1",
        [issue.id],
      );
      // The worker queues its update while the web transaction holds the row lock.
      const update = consumer.query(
        `UPDATE issue SET status='open', "eventCount"="eventCount"+1 WHERE id=$1 RETURNING status, regression, "eventCount"`,
        [issue.id],
      );

      await expect
        .poll(
          async () => {
            const rows = await instance.admin.$queryRaw<
              { wait_event_type: string | null }[]
            >`SELECT wait_event_type FROM pg_stat_activity WHERE pid = ${consumerPid}`;

            return rows[0]?.wait_event_type;
          },
          { timeout: 2000, interval: 10 },
        )
        .toBe("Lock");
      await writer.query("COMMIT");
      expect((await update).rows[0]).toMatchObject({
        status: "open",
        regression: true,
        eventCount: 2,
      });
    } finally {
      await writer.query("ROLLBACK");
      await Promise.all([writer.end(), consumer.end()]);
    }
  });
});
