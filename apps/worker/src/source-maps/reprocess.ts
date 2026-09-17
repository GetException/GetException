import { randomUUID } from "node:crypto";
import type { Database, Prisma } from "@getexception/db";
import { safeEventSchema } from "@getexception/protocol";
import { SourceMapStore } from "@getexception/source-maps";
import { fingerprint } from "../fingerprint";
import { resolveFrames } from "./resolve";

export async function reprocessOneEvent(
  db: Database,
  store = new SourceMapStore(),
) {
  const rows = await db.$queryRaw<
    { id: string }[]
  >`SELECT e.id FROM error_event e JOIN release r ON r."projectId" = e."projectId" AND r.name = e.release JOIN project p ON p.id = e."projectId" WHERE e."symbolicationVersion" < r."sourceMapsVersion" AND p."deletedAt" IS NULL ORDER BY e."receivedAt" LIMIT 1`;

  if (!rows[0]) {
    return false;
  }

  const event = await db.errorEvent.findUnique({ where: { id: rows[0].id } });

  if (!event) {
    return true;
  }

  const safe = safeEventSchema.parse({
    eventId: event.eventId,
    timestamp: event.timestamp.getTime() / 1000,
    level: event.level,
    message: event.message,
    exceptionType: event.exceptionType,
    handled: event.handled,
    environment: event.environment,
    ...(event.release ? { release: event.release } : {}),
    frames: event.frames,
    tags: event.tags,
    breadcrumbs: event.breadcrumbs,
  });
  const result = await resolveFrames(db, event.projectId, safe, store);
  const hash = fingerprint(result.event);

  await db.$transaction(async (tx) => {
    const locked = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM error_event WHERE id = ${event.id} AND "symbolicationVersion" = ${event.symbolicationVersion} FOR UPDATE`;

    if (!locked.length) {
      return;
    }

    const previous = await tx.issue.findUnique({
      where: { id: event.issueId },
    });

    if (!previous) {
      return;
    }

    let issueId = previous.id;

    if (previous.fingerprint !== hash) {
      // Lock in a consistent project order for merges from concurrent reprocessors.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtextextended(${event.projectId}, 713))`;
      const destination = await tx.issue.upsert({
        where: {
          projectId_fingerprint: {
            projectId: event.projectId,
            fingerprint: hash,
          },
        },
        create: {
          projectId: event.projectId,
          fingerprint: hash,
          title: event.message,
          exceptionType: event.exceptionType,
          firstSeen: event.receivedAt,
          lastSeen: event.receivedAt,
          eventCount: 1,
          status: previous.status,
        },
        update: {
          eventCount: { increment: 1 },
          firstSeen: event.receivedAt,
          lastSeen: event.receivedAt,
        },
      });

      issueId = destination.id;
      await tx.issue.update({
        where: { id: previous.id },
        data: { eventCount: { decrement: 1 } },
      });
      await tx.issueActivity.create({
        data: {
          projectId: event.projectId,
          fromIssueId: previous.id,
          toIssueId: issueId,
          eventId: event.eventId,
        },
      });
      await tx.$executeRaw`INSERT INTO audit_log(id, action, success) VALUES (${randomUUID()}, 'issue_symbolication', true)`;
    }

    await tx.errorEvent.update({
      where: { id: event.id },
      data: {
        issueId,
        originalFrames: result.originalFrames as Prisma.InputJsonValue,
        symbolicationState: result.state,
        symbolicationVersion: result.version,
      },
    });
  });

  return true;
}
