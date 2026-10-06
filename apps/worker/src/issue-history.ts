import type { Transaction } from "@getexception/db";
import { RETENTION_DAYS, type SafeEvent } from "@getexception/protocol";

type Issue = {
  id: string;
  projectId: string;
  fingerprint: string;
  firstSeen: Date;
};

export async function recordIssueObservation(
  tx: Transaction,
  issue: Issue,
  event: Pick<SafeEvent, "eventId" | "environment" | "release" | "appVersion">,
  receivedAt: Date,
  observedFingerprint: string,
  knownFirst?: boolean,
) {
  const project = await tx.project.findUniqueOrThrow({
    where: { id: issue.projectId },
    select: { issueHistoryStartedAt: true },
  });
  const cutoff = new Date(
    receivedAt.getTime() - RETENTION_DAYS.issueHistory * 86400_000,
  );
  const firstSeenKnown =
    knownFirst ??
    (issue.firstSeen >= project.issueHistoryStartedAt ||
      project.issueHistoryStartedAt <= cutoff);

  for (const hash of new Set([issue.fingerprint, observedFingerprint])) {
    await tx.issueHistory.deleteMany({
      where: {
        projectId: issue.projectId,
        fingerprint: hash,
        environment: event.environment,
        lastSeen: { lt: cutoff },
      },
    });
    const observation = {
      issueId: issue.id,
      canonical: hash === issue.fingerprint,
      firstSeen: receivedAt,
      lastSeen: receivedAt,
      firstEventId: event.eventId,
      lastEventId: event.eventId,
      firstRelease: event.release ?? null,
      lastRelease: event.release ?? null,
      firstAppVersion: event.appVersion ?? null,
      lastAppVersion: event.appVersion ?? null,
      firstSeenKnown,
    };

    await tx.issueHistory.upsert({
      where: {
        projectId_fingerprint_environment: {
          projectId: issue.projectId,
          fingerprint: hash,
          environment: event.environment,
        },
      },
      create: {
        projectId: issue.projectId,
        fingerprint: hash,
        environment: event.environment,
        ...observation,
      },
      update: observation,
    });
  }
}

export async function transferIssueHistory(
  tx: Transaction,
  previous: Issue,
  destination: Issue,
) {
  const histories = await tx.issueHistory.findMany({
    where: { issueId: previous.id, canonical: true },
  });

  for (const history of histories) {
    const data = {
      projectId: history.projectId,
      environment: history.environment,
      issueId: destination.id,
      canonical: true,
      firstSeen: history.firstSeen,
      lastSeen: history.lastSeen,
      firstEventId: history.firstEventId,
      lastEventId: history.lastEventId,
      firstRelease: history.firstRelease,
      lastRelease: history.lastRelease,
      firstAppVersion: history.firstAppVersion,
      lastAppVersion: history.lastAppVersion,
      firstSeenKnown: history.firstSeenKnown,
    };

    await tx.issueHistory.upsert({
      where: {
        projectId_fingerprint_environment: {
          projectId: destination.projectId,
          fingerprint: destination.fingerprint,
          environment: history.environment,
        },
      },
      create: { fingerprint: destination.fingerprint, ...data },
      update: data,
    });
  }

  // Old fingerprints remain bounded aliases, so events without maps find the same group.
  await tx.issueHistory.updateMany({
    where: { issueId: previous.id },
    data: { issueId: destination.id, canonical: false },
  });
}
