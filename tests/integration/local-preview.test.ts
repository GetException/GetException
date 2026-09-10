import { expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { randomBytes, randomUUID } from "node:crypto";
import { createDatabase, type Database } from "@getexception/db";
import { webConfig } from "@getexception/config";
import { startLocalDatabase } from "../../scripts/local/database";
import {
  availablePort,
  databaseUrl,
  loadState,
  localWebConfig,
} from "../../scripts/local/state";
import { AuthService } from "../../apps/web/src/server/auth-service";
import { createRuntime } from "../../apps/web/src/server/runtime";
import { digest, totp } from "../../apps/web/src/server/crypto";

it("keeps the account, MFA, session, project, event and keys through a native PostgreSQL restart", async () => {
  process.umask(0o077);
  const directory = mkdtempSync(join(tmpdir(), "getexception-local-test-"));
  let database: Awaited<ReturnType<typeof startLocalDatabase>> | undefined;
  let web: Database | undefined, worker: Database | undefined;

  try {
    const initial = await loadState(directory, await availablePort());

    database = await startLocalDatabase(directory, initial);
    web = createDatabase(databaseUrl(initial, "web"));
    worker = createDatabase(databaseUrl(initial, "worker"));
    const service = new AuthService(web, webConfig(localWebConfig(initial)));
    const password = randomBytes(24).toString("base64url");
    const setup = readFileSync(join(directory, "setup-token"), "utf8");
    const access = await service.setupAccess(setup, "local-restart-test");
    const pending = await service.prepareSetup(
      access,
      { email: "restart@example.test", password, domain: "monitor.localhost" },
      "local-restart-test",
    );
    const result = await service.finishSetup(
      access,
      totp(pending.secret, BigInt(Math.floor(Date.now() / 30_000)) - 1n),
      "local-restart-test",
    );
    const runtime = createRuntime(service.config, web);
    const response = await runtime.auth.handler(
      new Request(service.config.DASHBOARD_ORIGIN + "/api/auth/owner/login", {
        method: "POST",
        headers: {
          Origin: service.config.DASHBOARD_ORIGIN,
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          email: "restart@example.test",
          password,
          recoveryCode: result.recoveryCodes[0],
          trustDevice: false,
        }),
      }),
    );

    expect(response.status).toBe(200);
    const headers = new Headers({
      Cookie: response.headers.get("set-cookie")!.split(";")[0]!,
    });
    const member = await web.member.findFirstOrThrow();
    const keyHash = digest(randomBytes(32).toString("hex"));
    const project = await web.project.create({
      data: {
        name: "Saved project",
        slug: "saved",
        organizationId: member.organizationId,
        keys: { create: { keyHash } },
      },
    });
    const issue = await worker.issue.create({
      data: {
        projectId: project.id,
        fingerprint: "restart-check",
        title: "Saved error",
        exceptionType: "Error",
        firstSeen: new Date(),
        lastSeen: new Date(),
        eventCount: 1,
      },
    });

    await worker.errorEvent.create({
      data: {
        projectId: project.id,
        issueId: issue.id,
        eventId: randomBytes(16).toString("hex"),
        receivedAt: new Date(),
        timestamp: new Date(),
        message: "Saved error",
        exceptionType: "Error",
        environment: "development",
        handled: true,
        level: "error",
        frames: [],
        breadcrumbs: [],
        tags: {},
      },
    });
    const credential = await web.mfaCredential.findFirstOrThrow();
    const configBefore = readFileSync(join(directory, "config.json"), "utf8");

    await Promise.all([web.$disconnect(), worker.$disconnect()]);
    web = undefined;
    worker = undefined;
    await database.stop();
    database = undefined;
    const restored = await loadState(directory);

    expect(
      readFileSync(join(directory, "config.json"), "utf8") === configBefore,
    ).toBe(true);
    expect(restored.ports.https).toBe(initial.ports.https);
    expect(statSync(join(directory, "config.json")).mode & 0o777).toBe(0o600);
    database = await startLocalDatabase(directory, restored);
    expect(database.installed).toBe(true);
    web = createDatabase(databaseUrl(restored, "web"));
    const resumed = new AuthService(web, webConfig(localWebConfig(restored)));

    await expect(resumed.authorize(headers)).resolves.toBeDefined();
    expect(await web.bootstrapToken.count()).toBe(0);
    expect(await web.user.count()).toBe(1);
    expect(await web.project.count({ where: { id: project.id } })).toBe(1);
    expect(await web.errorEvent.count({ where: { issueId: issue.id } })).toBe(
      1,
    );
    expect(
      (await web.projectIngestionKey.findFirstOrThrow()).keyHash === keyHash,
    ).toBe(true);
    const after = await web.mfaCredential.findFirstOrThrow();

    expect(after.ciphertext === credential.ciphertext).toBe(true);
    expect(after.id).toBe(credential.id);
    await expect(
      resumed.login(
        {
          email: "restart@example.test",
          password,
          code: totp(pending.secret, BigInt(Math.floor(Date.now() / 30_000))),
          trustDevice: false,
        },
        "local-restart-test",
      ),
    ).resolves.toBeDefined();
    await expect(resumed.setupAccess(setup, randomUUID())).rejects.toThrow();
  } finally {
    await Promise.all([web?.$disconnect(), worker?.$disconnect()]);
    await database?.stop();
    rmSync(directory, { recursive: true, force: true });
  }
}, 60_000);
