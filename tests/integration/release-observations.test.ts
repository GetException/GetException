import { afterAll, beforeAll, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { createDatabase } from "@getexception/db";
import { sanitizeEvent } from "@getexception/protocol";
import { temporaryDatabase } from "./database";
import { claim, processJob, retainBatch } from "../../apps/worker/src/events";
import { transferIssueHistory } from "../../apps/worker/src/issue-history";
import { retainReleases } from "../../apps/worker/src/release-retention";
import { issueFilters, issueWhere } from "../../apps/web/src/server/filters";
import { newInReleaseHistoryScope } from "../../apps/web/src/server/issues/history";
import {
  releaseFilters,
  releaseWhere,
} from "../../apps/web/src/server/releases/filters";
import {
  releasePageIds,
  releaseIssuePageIds,
} from "../../apps/web/src/server/releases/list";
import { registerRelease } from "../../apps/web/src/server/releases/register";
import { createRuntime } from "../../apps/web/src/server/runtime";
import { digest, token } from "../../apps/web/src/server/crypto";

let instance: Awaited<ReturnType<typeof temporaryDatabase>>;
let worker: ReturnType<typeof createDatabase>;
let web: ReturnType<typeof createDatabase>;
let organizationId: string;
const now = new Date();
const daysAgo = (days: number) => new Date(now.getTime() - days * 86400_000);
const releaseA = `account@${"a".repeat(40)}`;
const releaseB = `account@${"b".repeat(40)}`;
const owner = () => ({ id: "owner", role: "owner", organizationId });

beforeAll(async () => {
  instance = await temporaryDatabase();
  worker = createDatabase(instance.urls.worker);
  web = createDatabase(instance.urls.web);
  organizationId = randomUUID();
  await instance.admin.organization.create({
    data: { id: organizationId, name: "Versions", slug: "versions" },
  });
  await instance.admin.systemSetting.create({
    data: { domain: "monitor.example.test" },
  });
});

afterAll(async () => {
  await Promise.all([worker?.$disconnect(), web?.$disconnect()]);
  await instance?.cleanup();
});

async function project() {
  const slug = randomUUID();

  return instance.admin.project.create({
    data: {
      organizationId,
      name: "Account",
      slug,
      issueHistoryStartedAt: daysAgo(120),
    },
  });
}

async function occurrence(
  projectId: string,
  release: string | undefined,
  receivedAt = now,
  environment = "production",
  appVersion = "3.192.75",
) {
  const eventId = randomBytes(16).toString("hex");
  const payload = sanitizeEvent(
    {
      message: "Observation",
      release,
      environment,
      contexts: { app: { version: appVersion } },
    },
    eventId,
  );
  const queued = await instance.admin.eventInbox.create({
    data: { projectId, eventId, payload },
  });

  await instance.admin.eventInbox.update({
    where: { id: queued.id },
    data: { receivedAt },
  });
  const job = await claim(worker);

  expect(job).not.toBeNull();
  await processJob(worker, job!);

  return {
    job: job!,
    event: await instance.admin.errorEvent.findUniqueOrThrow({
      where: { projectId_eventId: { projectId, eventId } },
    }),
  };
}

it("preserves first release across retries and out-of-order jobs, independently by environment", async () => {
  const p = await project();
  const newer = await occurrence(p.id, releaseB, daysAgo(1));
  const older = await occurrence(p.id, releaseA, daysAgo(2));

  await processJob(worker, older.job);
  await occurrence(p.id, releaseB, now, "staging");
  const histories = await web.issueHistory.findMany({
    where: { issueId: newer.event.issueId, canonical: true },
    orderBy: { environment: "asc" },
  });

  expect(histories).toHaveLength(2);
  expect(histories[0]).toMatchObject({
    environment: "production",
    firstRelease: releaseA,
    lastRelease: releaseB,
    firstSeen: daysAgo(2),
    firstSeenKnown: true,
  });
  expect(histories[1]).toMatchObject({
    environment: "staging",
    firstRelease: releaseB,
    firstSeenKnown: true,
  });
  expect(
    (await web.issue.findUniqueOrThrow({ where: { id: newer.event.issueId } }))
      .eventCount,
  ).toBe(3);
  expect(
    await web.issue.count({
      where: issueWhere(
        owner(),
        issueFilters({
          project: p.id,
          release: releaseB,
          environment: "production",
          novelty: "new",
        }),
      ),
    }),
  ).toBe(0);
  expect(
    await web.issue.count({
      where: issueWhere(
        owner(),
        issueFilters({
          project: p.id,
          release: releaseB,
          environment: "staging",
          novelty: "new",
        }),
      ),
    }),
  ).toBe(1);
  expect(
    await releaseIssuePageIds(
      web,
      p.id,
      releaseB,
      "production",
      { sort: "events", direction: "desc" },
      1,
      true,
    ),
  ).toEqual([]);
  expect(
    await releaseIssuePageIds(
      web,
      p.id,
      releaseB,
      "staging",
      { sort: "events", direction: "desc" },
      1,
      true,
    ),
  ).toEqual([{ id: newer.event.issueId }]);
  expect(
    await web.issueHistory.count({
      where: {
        projectId: p.id,
        ...newInReleaseHistoryScope(releaseB, "staging"),
      },
    }),
  ).toBe(1);
});

it("remembers an expired group for 90 days and does not mark its recurrence as new", async () => {
  const p = await project();
  const old = await occurrence(p.id, releaseA, daysAgo(40));

  await retainBatch(worker, now);
  expect(
    await web.issue.findUnique({ where: { id: old.event.issueId } }),
  ).toBeNull();
  expect(
    await web.issueHistory.findFirst({ where: { projectId: p.id } }),
  ).toMatchObject({ issueId: null, firstRelease: releaseA });
  const current = await occurrence(p.id, releaseB);

  expect(current.event.issueId).not.toBe(old.event.issueId);
  expect(
    await web.issueHistory.findFirst({
      where: { issueId: current.event.issueId },
    }),
  ).toMatchObject({ firstRelease: releaseA, lastRelease: releaseB });
  expect(
    await web.issue.count({
      where: issueWhere(
        owner(),
        issueFilters({ project: p.id, release: releaseB, novelty: "new" }),
      ),
    }),
  ).toBe(0);
});

it("expires observation history and starts a new bounded window, even before cleanup catches up", async () => {
  const p = await project();

  await occurrence(p.id, releaseA, daysAgo(91));
  const current = await occurrence(p.id, releaseB);

  expect(
    await web.issueHistory.findFirst({
      where: { issueId: current.event.issueId },
    }),
  ).toMatchObject({ firstRelease: releaseB, firstSeenKnown: true });
  const stale = await project();

  await occurrence(stale.id, releaseA, daysAgo(91));
  await retainBatch(worker, now);
  expect(await web.issueHistory.count({ where: { projectId: stale.id } })).toBe(
    0,
  );
});

it("does not invent a first release when it was missing, or when earlier history is unavailable", async () => {
  const p = await project();

  await occurrence(p.id, undefined, daysAgo(1));
  await occurrence(p.id, releaseB);
  expect(
    await web.issueHistory.findFirst({ where: { projectId: p.id } }),
  ).toMatchObject({ firstRelease: null, lastRelease: releaseB });
  expect(
    await web.issue.count({
      where: issueWhere(
        owner(),
        issueFilters({ project: p.id, release: releaseB, novelty: "new" }),
      ),
    }),
  ).toBe(0);
  const legacy = await project();

  await instance.admin.project.update({
    where: { id: legacy.id },
    data: { issueHistoryStartedAt: now },
  });
  const old = await occurrence(legacy.id, releaseA, daysAgo(1));

  expect(
    await web.issueHistory.findFirst({ where: { issueId: old.event.issueId } }),
  ).toMatchObject({ firstSeenKnown: false });
  expect(
    await web.issue.count({
      where: issueWhere(
        owner(),
        issueFilters({ project: legacy.id, release: releaseA, novelty: "new" }),
      ),
    }),
  ).toBe(0);
});

it("transfers the historical first release during regrouping and keeps compiled fingerprints as aliases", async () => {
  const p = await project();
  const old = await occurrence(p.id, releaseA, daysAgo(40));
  const original = await instance.admin.issue.findUniqueOrThrow({
    where: { id: old.event.issueId },
  });
  const destination = await instance.admin.issue.create({
    data: {
      projectId: p.id,
      fingerprint: "mapped-fingerprint",
      title: "Observation",
      exceptionType: "Error",
      firstSeen: now,
      lastSeen: now,
    },
  });

  await worker.$transaction((tx) =>
    transferIssueHistory(tx, original, destination),
  );
  expect(
    await web.issueHistory.findFirst({
      where: { issueId: destination.id, canonical: true },
    }),
  ).toMatchObject({
    fingerprint: "mapped-fingerprint",
    firstSeen: daysAgo(40),
    firstRelease: releaseA,
  });
  expect(
    await web.issueHistory.findFirst({
      where: { fingerprint: original.fingerprint, projectId: p.id },
    }),
  ).toMatchObject({ canonical: false, issueId: destination.id });
  const current = await occurrence(p.id, releaseB);

  expect(current.event.issueId).toBe(destination.id);
  expect(
    await web.issueHistory.findFirst({
      where: { issueId: destination.id, canonical: true },
    }),
  ).toMatchObject({ firstRelease: releaseA, lastRelease: releaseB });
});

it("keeps metadata referenced by active history and protects history with pending jobs", async () => {
  const p = await project();

  await occurrence(p.id, releaseA, daysAgo(40));
  await instance.admin.release.updateMany({
    where: { projectId: p.id },
    data: { lastActivityAt: daysAgo(91) },
  });
  await retainReleases(worker, now);
  expect(await web.release.count({ where: { projectId: p.id } })).toBe(1);
  const stale = await project();

  await occurrence(stale.id, releaseA, daysAgo(91));
  const pending = await instance.admin.eventInbox.create({
    data: {
      projectId: stale.id,
      eventId: randomBytes(16).toString("hex"),
      payload: {},
    },
  });

  await retainBatch(worker, now);
  expect(await web.issueHistory.count({ where: { projectId: stale.id } })).toBe(
    1,
  );
  await instance.admin.eventInbox.delete({ where: { id: pending.id } });
  await retainBatch(worker, now);
  expect(await web.issueHistory.count({ where: { projectId: stale.id } })).toBe(
    0,
  );
});

it("registers authorized version metadata without maps and event versions cannot overwrite it", async () => {
  const p = await project();
  const secret = token();

  await instance.admin.sourceMapToken.create({
    data: {
      projectId: p.id,
      name: "Version CI",
      tokenHash: digest(secret),
      expiresAt: new Date(Date.now() + 3600000),
    },
  });
  const service = createRuntime(
    {
      DATABASE_URL: instance.urls.web,
      DASHBOARD_ORIGIN: "https://monitor.example.test",
      INGEST_ORIGIN: "https://ingest.example.test",
      BETTER_AUTH_SECRET: token(),
      TOTP_ENCRYPTION_KEY: token(),
      AUTH_RATE_KEY: token(),
    },
    web,
  ).service;

  await occurrence(p.id, releaseA, now, "production", "3.192.74");
  await registerRelease(
    service,
    new Headers({
      authorization: `Bearer ${secret}`,
      "x-real-ip": "version-test",
    }),
    p.id,
    {
      release: releaseA,
      appVersion: "3.192.75",
      deployment: { environment: "production" },
    },
  );
  await occurrence(p.id, releaseA, now, "production", "9.9.9");
  expect(
    await web.release.findFirst({ where: { projectId: p.id, name: releaseA } }),
  ).toMatchObject({ appVersion: "3.192.75", sourceMapsState: "missing" });
  await expect(
    registerRelease(service, new Headers(), p.id, {
      release: releaseA,
      appVersion: "3.192.76",
      deployment: { environment: "production" },
    }),
  ).rejects.toMatchObject({ status: 401 });
});

it("searches and sorts semantic versions and enforces project boundaries on history", async () => {
  const p = await project();
  const versions = [
    "3.192.100",
    "3.192.75",
    "3.192.9",
    "3.192.75-beta.11",
    "3.192.75-beta.2",
    "3.192.75-alpha",
  ];

  for (const [index, appVersion] of versions.entries()) {
    await instance.admin.release.create({
      data: {
        projectId: p.id,
        name: `account@${String(index).padStart(40, "0")}`,
        appVersion,
      },
    });
  }

  const filters = releaseFilters({
    project: p.id,
    sort: "version",
    direction: "asc",
  });
  const ids = await releasePageIds(web, owner(), filters);
  const rows = await web.release.findMany({
    where: { id: { in: ids.map(({ id }) => id) } },
  });

  expect(
    ids.map(({ id }) => rows.find((r) => r.id === id)?.appVersion),
  ).toEqual([
    "3.192.9",
    "3.192.75-alpha",
    "3.192.75-beta.2",
    "3.192.75-beta.11",
    "3.192.75",
    "3.192.100",
  ]);
  expect(
    await web.release.count({
      where: releaseWhere(
        owner(),
        releaseFilters({ project: p.id, q: "3.192.75" }),
      ),
    }),
  ).toBe(4);
  const inaccessible = { id: "viewer", organizationId, role: "viewer" };

  expect(await releasePageIds(web, inaccessible, filters)).toEqual([]);
  expect(
    await web.issue.count({
      where: issueWhere(
        inaccessible,
        issueFilters({ project: p.id, release: releaseA, novelty: "new" }),
      ),
    }),
  ).toBe(0);
  const foreign = await project();
  const current = await occurrence(p.id, releaseA);

  await expect(
    instance.admin.issueHistory.updateMany({
      where: { projectId: p.id },
      data: { issueId: (await occurrence(foreign.id, releaseA)).event.issueId },
    }),
  ).rejects.toThrow();
  expect(current.event.projectId).toBe(p.id);
  const ingest = createDatabase(instance.urls.ingest);

  try {
    await expect(
      ingest.$queryRaw`SELECT id FROM issue_history LIMIT 1`,
    ).rejects.toThrow();
  } finally {
    await ingest.$disconnect();
  }
});

it("does not qualify a release from an expired occurrence in another environment", async () => {
  const p = await project();

  await occurrence(p.id, releaseA, daysAgo(40), "staging");
  await occurrence(p.id, releaseB, daysAgo(1), "production");
  await occurrence(p.id, releaseA, now, "production");
  await retainBatch(worker, now);
  const filters = issueFilters({
    project: p.id,
    release: releaseA,
    novelty: "new",
  });

  expect(await web.issue.count({ where: issueWhere(owner(), filters) })).toBe(
    0,
  );
  expect(
    await web.issueHistory.count({
      where: { projectId: p.id, ...newInReleaseHistoryScope(releaseA) },
    }),
  ).toBe(0);
  expect(
    await releaseIssuePageIds(
      web,
      p.id,
      releaseA,
      "all",
      { sort: "events", direction: "desc" },
      1,
      true,
    ),
  ).toEqual([]);
});
