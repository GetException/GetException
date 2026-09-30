import { afterAll, beforeAll, expect, it } from "vitest";
import { randomBytes, randomUUID } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDatabase, Prisma } from "@getexception/db";
import { SourceMapStore } from "@getexception/source-maps";
import { retainExpiredAuth } from "../../apps/worker/src/auth-retention";
import { retainBatch } from "../../apps/worker/src/events";
import { retainReleases } from "../../apps/worker/src/release-retention";
import { retainSourceMaps } from "../../apps/worker/src/source-maps/retention";
import { issueFilters, issueWhere } from "../../apps/web/src/server/filters";
import { temporaryDatabase } from "./database";

let instance: Awaited<ReturnType<typeof temporaryDatabase>>;
let worker: ReturnType<typeof createDatabase>;
let organizationId: string;
const now = new Date();
const old = new Date(now.getTime() - 31 * 86_400_000);
const recent = new Date(now.getTime() - 86_400_000);
const veryOld = new Date(now.getTime() - 91 * 86_400_000);
const directory = mkdtempSync(join(tmpdir(), "getexception-retention-"));
const store = new SourceMapStore(directory);

beforeAll(async () => {
  instance = await temporaryDatabase();
  worker = createDatabase(instance.urls.worker);
  organizationId = randomUUID();
  await instance.admin.organization.create({
    data: {
      id: organizationId,
      name: "Retention tests",
      slug: "retention-tests",
    },
  });
  await instance.admin.systemSetting.create({
    data: { id: 1, domain: "retention.example.test" },
  });
});

afterAll(async () => {
  await worker?.$disconnect();
  await instance?.cleanup();
  rmSync(directory, { recursive: true, force: true });
});

async function project() {
  const id = randomUUID();

  return instance.admin.project.create({
    data: { organizationId, name: id, slug: id },
  });
}

async function issue(projectId: string, lastSeen: Date, status = "open") {
  return instance.admin.issue.create({
    data: {
      projectId,
      fingerprint: randomUUID(),
      title: "A problem",
      exceptionType: "TypeError",
      status,
      eventCount: 1,
      firstSeen: lastSeen,
      lastSeen,
    },
  });
}

async function event(
  projectId: string,
  issueId: string,
  receivedAt: Date,
  release: string | null = null,
  frames: Prisma.InputJsonValue = [],
) {
  return instance.admin.errorEvent.create({
    data: {
      projectId,
      issueId,
      eventId: randomBytes(16).toString("hex"),
      receivedAt,
      timestamp: receivedAt,
      environment: "staging",
      release,
      level: "error",
      message: "A problem",
      exceptionType: "TypeError",
      handled: false,
      frames,
      breadcrumbs: [],
      tags: {},
    },
  });
}

it("expires open and resolved groups only after their last event, and bounds receipts and statistics", async () => {
  const p = await project();
  const staleOpen = await issue(p.id, old);
  const staleResolved = await issue(p.id, old, "resolved");
  const historical = await issue(p.id, old);
  const active = await issue(p.id, recent);

  await event(p.id, staleOpen.id, old);
  await event(p.id, staleResolved.id, old);
  await event(p.id, active.id, recent);

  for (const status of ["done", "dead", "discarded", "pending", "processing"]) {
    await instance.admin.eventInbox.create({
      data: {
        id: randomUUID(),
        projectId: p.id,
        eventId: randomBytes(16).toString("hex"),
        payload: status === "dead" ? { release: "old" } : {},
        status,
        receivedAt: old,
      },
    });
  }

  await instance.admin.eventInbox.updateMany({
    where: { projectId: p.id },
    data: { receivedAt: old },
  });
  await instance.admin.projectDailyStat.create({
    data: { projectId: p.id, day: veryOld, accepted: 1 },
  });
  await instance.admin.issueActivity.create({
    data: {
      projectId: p.id,
      fromIssueId: staleOpen.id,
      toIssueId: active.id,
      eventId: randomBytes(16).toString("hex"),
      createdAt: old,
    },
  });
  await instance.admin.issueActivity.create({
    data: {
      projectId: p.id,
      fromIssueId: historical.id,
      toIssueId: active.id,
      eventId: randomBytes(16).toString("hex"),
      createdAt: recent,
    },
  });

  expect(await retainBatch(worker, now)).toBe(2);
  expect(
    (
      await instance.admin.issue.findMany({
        where: { projectId: p.id },
        select: { id: true },
      })
    )
      .map(({ id }) => id)
      .sort(),
  ).toEqual([active.id, historical.id].sort());
  expect(
    await instance.admin.issue.findMany({
      where: issueWhere(
        { id: "owner", role: "owner", organizationId },
        issueFilters({}),
        now.getTime(),
      ),
      select: { id: true },
    }),
  ).toEqual([{ id: active.id }]);
  expect(
    (
      await instance.admin.eventInbox.findMany({
        where: { projectId: p.id },
        select: { status: true },
      })
    )
      .map(({ status }) => status)
      .sort(),
  ).toEqual(["pending", "processing"]);
  expect(
    await instance.admin.issueActivity.count({ where: { projectId: p.id } }),
  ).toBe(1);
  expect(
    await instance.admin.projectDailyStat.count({ where: { projectId: p.id } }),
  ).toBe(1);
});

it("retires release metadata after 90 idle days but preserves references and recent activity", async () => {
  const p = await project();
  const stale = await instance.admin.release.create({
    data: {
      projectId: p.id,
      name: `account@${"a".repeat(40)}`,
      createdAt: veryOld,
      lastActivityAt: veryOld,
    },
  });
  const active = await instance.admin.release.create({
    data: {
      projectId: p.id,
      name: `account@${"b".repeat(40)}`,
      createdAt: veryOld,
      lastActivityAt: recent,
    },
  });
  const referenced = await instance.admin.release.create({
    data: {
      projectId: p.id,
      name: `account@${"c".repeat(40)}`,
      createdAt: veryOld,
      lastActivityAt: veryOld,
    },
  });
  const withUpload = await instance.admin.release.create({
    data: {
      projectId: p.id,
      name: `account@${"e".repeat(40)}`,
      createdAt: veryOld,
      lastActivityAt: veryOld,
    },
  });
  const withInbox = await instance.admin.release.create({
    data: {
      projectId: p.id,
      name: `account@${"f".repeat(40)}`,
      createdAt: veryOld,
      lastActivityAt: veryOld,
    },
  });
  const upload = await instance.admin.sourceMapUpload.create({
    data: {
      projectId: p.id,
      release: withUpload.name,
      manifestHash: randomBytes(32).toString("hex"),
      status: "ready",
    },
  });
  const inbox = await instance.admin.eventInbox.create({
    data: {
      id: randomUUID(),
      projectId: p.id,
      eventId: randomBytes(16).toString("hex"),
      payload: { release: withInbox.name },
      status: "pending",
    },
  });
  const group = await issue(p.id, recent);

  await event(p.id, group.id, recent, referenced.name);
  expect(await retainReleases(worker, now)).toBe(1);
  expect(
    await instance.admin.release.findUnique({ where: { id: stale.id } }),
  ).toBeNull();
  expect(
    await instance.admin.release.findUnique({ where: { id: active.id } }),
  ).not.toBeNull();
  expect(
    await instance.admin.release.findUnique({ where: { id: referenced.id } }),
  ).not.toBeNull();
  expect(
    await instance.admin.release.findUnique({ where: { id: withUpload.id } }),
  ).not.toBeNull();
  expect(
    await instance.admin.release.findUnique({ where: { id: withInbox.id } }),
  ).not.toBeNull();
  await instance.admin.errorEvent.deleteMany({ where: { projectId: p.id } });
  expect(await retainReleases(worker, now)).toBe(1);
  expect(
    await instance.admin.release.findUnique({ where: { id: referenced.id } }),
  ).toBeNull();
  await instance.admin.sourceMapUpload.delete({ where: { id: upload.id } });
  await instance.admin.eventInbox.delete({ where: { id: inbox.id } });
  expect(await retainReleases(worker, now)).toBe(2);

  await instance.admin.release.update({
    where: { id: active.id },
    data: { lastActivityAt: veryOld },
  });
  expect(
    (
      await instance.admin.release.findUniqueOrThrow({
        where: { id: active.id },
      })
    ).lastActivityAt,
  ).toEqual(recent);
});

it("retains only maps whose Debug IDs occur in saved events and handles stale uploads", async () => {
  const p = await project();
  const release = `account@${"d".repeat(40)}`;
  const releaseRow = await instance.admin.release.create({
    data: {
      projectId: p.id,
      name: release,
      sourceMapsState: "ready",
      sourceMapsVersion: 1,
    },
  });
  const debugIds = [randomUUID(), randomUUID()];
  const uploads = [];

  for (const debugId of debugIds) {
    const upload = await instance.admin.sourceMapUpload.create({
      data: {
        projectId: p.id,
        release,
        manifestHash: randomBytes(32).toString("hex"),
        status: "ready",
        createdAt: old,
        updatedAt: old,
      },
    });

    await instance.admin.sourceArtifact.create({
      data: {
        projectId: p.id,
        uploadId: upload.id,
        release,
        path: "app.js",
        debugId,
        sha256: randomBytes(32).toString("hex"),
        size: 100,
        storageId: randomUUID(),
      },
    });
    uploads.push(upload);
  }

  const group = await issue(p.id, recent);

  await event(p.id, group.id, recent, release, [{ debug_id: debugIds[0] }]);
  await retainSourceMaps(worker, store, now);
  expect(
    await instance.admin.sourceMapUpload.findUnique({
      where: { id: uploads[0]!.id },
    }),
  ).not.toBeNull();
  expect(
    await instance.admin.sourceMapUpload.findUnique({
      where: { id: uploads[1]!.id },
    }),
  ).toBeNull();
  expect(
    await instance.admin.release.findUnique({ where: { id: releaseRow.id } }),
  ).toMatchObject({ sourceMapsState: "ready" });

  await event(p.id, group.id, recent, release, [{}]);
  const legacy = await instance.admin.sourceMapUpload.create({
    data: {
      projectId: p.id,
      release,
      manifestHash: randomBytes(32).toString("hex"),
      status: "ready",
      createdAt: old,
      updatedAt: old,
    },
  });

  await retainSourceMaps(worker, store, now);
  expect(
    await instance.admin.sourceMapUpload.findUnique({
      where: { id: legacy.id },
    }),
  ).not.toBeNull();

  const pending = await instance.admin.sourceMapUpload.create({
    data: {
      projectId: p.id,
      release,
      manifestHash: randomBytes(32).toString("hex"),
      status: "pending",
      createdAt: old,
      updatedAt: old,
    },
  });
  const validating = await instance.admin.sourceMapUpload.create({
    data: {
      projectId: p.id,
      release,
      manifestHash: randomBytes(32).toString("hex"),
      status: "validating",
      leaseUntil: old,
      createdAt: old,
      updatedAt: old,
    },
  });

  await retainSourceMaps(worker, store, now);
  expect(
    await instance.admin.sourceMapUpload.findUnique({
      where: { id: pending.id },
    }),
  ).toBeNull();
  expect(
    await instance.admin.sourceMapUpload.findUnique({
      where: { id: validating.id },
    }),
  ).toBeNull();

  await instance.admin.errorEvent.deleteMany({ where: { projectId: p.id } });
  const queued = await instance.admin.eventInbox.create({
    data: {
      id: randomUUID(),
      projectId: p.id,
      eventId: randomBytes(16).toString("hex"),
      payload: { release },
      status: "pending",
    },
  });

  await retainSourceMaps(worker, store, now);
  expect(
    await instance.admin.sourceMapUpload.count({ where: { projectId: p.id } }),
  ).toBe(2);
  await instance.admin.eventInbox.delete({ where: { id: queued.id } });
  await retainSourceMaps(worker, store, now);
  expect(
    await instance.admin.sourceMapUpload.count({ where: { projectId: p.id } }),
  ).toBe(0);
  expect(
    await instance.admin.release.findUnique({ where: { id: releaseRow.id } }),
  ).toMatchObject({ sourceMapsState: "removed" });
});

it("removes expired credentials through a bounded privileged function without granting worker auth access", async () => {
  const userId = randomUUID();
  const invitationId = randomUUID();

  await instance.admin.user.create({
    data: { id: userId, name: "Retention", email: "retention@example.test" },
  });
  await instance.admin.session.create({
    data: {
      id: randomUUID(),
      token: randomUUID(),
      userId,
      expiresAt: old,
    },
  });
  await instance.admin.session.create({
    data: {
      id: randomUUID(),
      token: randomUUID(),
      userId,
      expiresAt: new Date(now.getTime() + 86_400_000),
    },
  });
  await instance.admin.verification.create({
    data: {
      id: randomUUID(),
      identifier: "retention@example.test",
      value: randomUUID(),
      expiresAt: old,
    },
  });
  await instance.admin.setupSession.create({
    data: {
      id: randomUUID(),
      tokenHash: randomBytes(32).toString("hex"),
      userId,
      domain: "retention.example.test",
      email: "retention@example.test",
      passwordHash: "expired",
      pendingCiphertext: "expired",
      expiresAt: old,
    },
  });
  await instance.admin.mfaCredential.create({
    data: {
      id: randomUUID(),
      userId,
      state: "pending",
      ciphertext: "expired",
      expiresAt: old,
    },
  });
  await instance.admin.mfaCredential.create({
    data: {
      id: randomUUID(),
      userId,
      state: "active",
      ciphertext: "active",
    },
  });
  await instance.admin.authRateBucket.create({
    data: { id: randomUUID(), expiresAt: old },
  });
  await instance.admin.authRateBucket.create({
    data: { id: randomUUID(), expiresAt: new Date(now.getTime() + 86_400_000) },
  });
  await instance.admin.recoveryCode.create({
    data: { id: randomUUID(), userId, codeHash: randomUUID(), usedAt: old },
  });
  await instance.admin.recoveryCode.create({
    data: { id: randomUUID(), userId, codeHash: randomUUID() },
  });
  await instance.admin.invitation.create({
    data: {
      id: invitationId,
      organizationId,
      inviterId: userId,
      email: "expired@example.test",
      role: "viewer",
      tokenHash: randomBytes(32).toString("hex"),
      expiresAt: recent,
    },
  });
  await instance.admin.invitationEnrollment.create({
    data: {
      id: randomUUID(),
      invitationId,
      revision: 1,
      tokenHash: randomBytes(32).toString("hex"),
      name: "Expired",
      passwordHash: "expired",
      pendingCiphertext: "expired",
      expiresAt: recent,
    },
  });
  await instance.admin.invitationVerification.create({
    data: {
      id: randomUUID(),
      invitationId,
      revision: 1,
      tokenHash: randomBytes(32).toString("hex"),
      expiresAt: recent,
    },
  });
  await instance.admin.mailOutbox.create({
    data: {
      id: randomUUID(),
      invitationId,
      kind: "invitation",
      payload: "expired",
      status: "pending",
      expiresAt: recent,
      createdAt: new Date(now.getTime() - 2 * 86_400_000),
    },
  });
  const completedInvitation = await instance.admin.invitation.create({
    data: {
      id: randomUUID(),
      organizationId,
      inviterId: userId,
      email: "completed@example.test",
      role: "viewer",
      status: "accepted",
      expiresAt: veryOld,
      acceptedAt: veryOld,
    },
  });

  await instance.admin.mailOutbox.create({
    data: {
      id: randomUUID(),
      invitationId: completedInvitation.id,
      kind: "invitation",
      status: "sent",
      expiresAt: veryOld,
      createdAt: veryOld,
    },
  });

  const web = createDatabase(instance.urls.web);

  try {
    await expect(
      web.$queryRaw`SELECT purge_expired_auth_batch()`,
    ).rejects.toThrow();
  } finally {
    await web.$disconnect();
  }

  await expect(worker.session.findMany()).rejects.toThrow();
  await retainExpiredAuth(worker);
  expect(await instance.admin.session.count({ where: { userId } })).toBe(1);
  expect(await instance.admin.verification.count()).toBe(0);
  expect(await instance.admin.setupSession.count()).toBe(0);
  expect(
    await instance.admin.mfaCredential.findMany({ where: { userId } }),
  ).toMatchObject([{ state: "active" }]);
  expect(await instance.admin.authRateBucket.count()).toBe(1);
  expect(await instance.admin.recoveryCode.count({ where: { userId } })).toBe(
    1,
  );
  expect(
    await instance.admin.invitationEnrollment.count({
      where: { invitationId },
    }),
  ).toBe(0);
  expect(
    await instance.admin.invitationVerification.count({
      where: { invitationId },
    }),
  ).toBe(0);
  expect(
    await instance.admin.invitation.findUnique({ where: { id: invitationId } }),
  ).toMatchObject({
    status: "expired",
    tokenHash: null,
  });
  expect(
    await instance.admin.mailOutbox.findFirst({ where: { invitationId } }),
  ).toMatchObject({
    status: "cancelled",
    payload: null,
  });
  expect(
    await instance.admin.invitation.findUnique({
      where: { id: completedInvitation.id },
    }),
  ).toBeNull();
  expect(
    await instance.admin.mailOutbox.count({
      where: { invitationId: completedInvitation.id },
    }),
  ).toBe(0);
});
