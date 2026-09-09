import { fingerprint } from "./fingerprint";
import { randomUUID } from "node:crypto";
import { type Database, Prisma } from "@getexception/db";
import { safeEventSchema } from "@getexception/protocol";

const MAX_ATTEMPTS = 5;

export async function claim(db: Database, now = new Date()) {
  await db.eventInbox.updateMany({
    where: {
      status: "processing",
      leaseUntil: { lt: now },
      attempts: { gte: MAX_ATTEMPTS },
    },
    data: {
      status: "dead",
      leaseUntil: null,
      leaseToken: null,
      lastError: "lease_exhausted",
    },
  });

  return db.$transaction(
    async (tx) => {
      const ids = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM event_inbox WHERE "projectId" IS NOT NULL AND attempts < ${MAX_ATTEMPTS} AND ((status = 'pending' AND "nextAttemptAt" <= ${now}) OR (status = 'processing' AND "leaseUntil" < ${now})) ORDER BY "receivedAt", id FOR UPDATE SKIP LOCKED LIMIT 1`;

      if (!ids[0]) {
        return null;
      }

      return tx.eventInbox.update({
        where: { id: ids[0].id },
        data: {
          status: "processing",
          attempts: { increment: 1 },
          leaseToken: randomUUID(),
          leaseUntil: new Date(now.getTime() + 60_000),
        },
      });
    },
    { timeout: 5000 },
  );
}

export type Job = NonNullable<Awaited<ReturnType<typeof claim>>>;

export async function processJob(db: Database, job: Job) {
  // CPU work happens after the claim transaction has committed.
  const projectId = job.projectId;

  if (!projectId) {
    throw new Error("Invalid job");
  }

  const event = safeEventSchema.parse(job.payload);
  const hash = fingerprint(event);

  await db.$transaction(
    async (tx) => {
      // Fence an expired lease: an old worker cannot commit after a new claim.
      const owned = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM event_inbox WHERE id = ${job.id} AND "leaseToken" = ${job.leaseToken} AND status = 'processing' FOR UPDATE`;

      if (!owned.length) {
        return;
      }

      const existing = await tx.errorEvent.findUnique({
        where: { projectId_eventId: { projectId, eventId: job.eventId } },
        select: { id: true },
      });

      if (!existing) {
        const issue = await tx.issue.upsert({
          where: { projectId_fingerprint: { projectId, fingerprint: hash } },
          create: {
            projectId,
            fingerprint: hash,
            title: event.message,
            exceptionType: event.exceptionType,
            firstSeen: job.receivedAt,
            lastSeen: job.receivedAt,
            eventCount: 1,
          },
          update: {
            eventCount: { increment: 1 },
            lastSeen: job.receivedAt,
            status: "open",
          },
        });

        await tx.errorEvent.create({
          data: {
            projectId,
            eventId: job.eventId,
            issueId: issue.id,
            receivedAt: job.receivedAt,
            timestamp: new Date(event.timestamp * 1000),
            level: event.level,
            message: event.message,
            exceptionType: event.exceptionType,
            handled: event.handled,
            environment: event.environment,
            release: event.release,
            dist: event.dist,
            route: event.route,
            frames: event.frames as Prisma.InputJsonValue,
            tags: event.tags,
            breadcrumbs: event.breadcrumbs as Prisma.InputJsonValue,
          },
        });

        if (event.release) {
          await tx.release.upsert({
            where: { projectId_name: { projectId, name: event.release } },
            create: { projectId, name: event.release },
            update: {},
          });
        }
      }

      // Keep a small receipt for project/event idempotency; discard the queue copy.
      await tx.eventInbox.update({
        where: { id: job.id },
        data: {
          status: "done",
          payload: {},
          leaseToken: null,
          leaseUntil: null,
          lastError: null,
        },
      });
    },
    { timeout: 15_000 },
  );
}

export async function retryJob(db: Database, job: Job, now = new Date()) {
  const dead = job.attempts >= MAX_ATTEMPTS;

  await db.eventInbox.updateMany({
    where: { id: job.id, leaseToken: job.leaseToken, status: "processing" },
    data: {
      status: dead ? "dead" : "pending",
      nextAttemptAt: new Date(
        now.getTime() + Math.min(300_000, 1000 * 2 ** job.attempts),
      ),
      leaseToken: null,
      leaseUntil: null,
      lastError: dead ? "attempts_exhausted" : "processing_failed",
    },
  });

  return dead;
}

export async function runOne(db: Database) {
  const job = await claim(db);

  if (!job) {
    return false;
  }

  try {
    await processJob(db, job);
  } catch {
    await retryJob(db, job);
  }

  return true;
}

export async function retainBatch(db: Database, now = new Date(), batch = 100) {
  const cutoff = new Date(now.getTime() - 30 * 86400_000);
  const records = await db.errorEvent.findMany({
    where: { receivedAt: { lt: cutoff } },
    orderBy: { receivedAt: "asc" },
    take: Math.min(500, Math.max(1, batch)),
    select: { id: true },
  });
  const removed = await db.errorEvent.deleteMany({
    where: { id: { in: records.map((row) => row.id) } },
  });
  const dead = await db.eventInbox.findMany({
    where: { status: "dead", receivedAt: { lt: cutoff } },
    take: 100,
    select: { id: true },
  });

  await db.eventInbox.updateMany({
    where: { id: { in: dead.map((row) => row.id) } },
    data: { payload: {}, status: "discarded" },
  });

  return removed.count;
}

export async function queueMetrics(db: Database) {
  const where = { status: { in: ["pending", "processing"] } };
  const [depth, oldest, dead] = await Promise.all([
    db.eventInbox.count({ where }),
    db.eventInbox.findFirst({
      where,
      orderBy: { receivedAt: "asc" },
      select: { receivedAt: true },
    }),
    db.eventInbox.count({ where: { status: "dead" } }),
  ]);

  return {
    depth,
    oldestAgeSeconds: oldest
      ? Math.max(0, (Date.now() - oldest.receivedAt.getTime()) / 1000)
      : 0,
    dead,
  };
}
