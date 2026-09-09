import { randomUUID } from "node:crypto";
import type { Database } from "@getexception/db";
import { openMail, type MailPayload } from "@getexception/mail";

export type MailSender = (
  payload: MailPayload,
  messageId: string,
) => Promise<void>;

export async function claimMail(db: Database, now = new Date()) {
  await db.mailOutbox.updateMany({
    where: {
      status: { in: ["pending", "processing"] },
      expiresAt: { lte: now },
    },
    data: {
      payload: null,
      status: "cancelled",
      leaseToken: null,
      leaseUntil: null,
    },
  });
  await db.mailOutbox.updateMany({
    where: {
      status: "processing",
      leaseUntil: { lt: now },
      attempts: { gte: 5 },
    },
    data: {
      payload: null,
      status: "dead",
      leaseToken: null,
      leaseUntil: null,
      lastError: "attempts_exhausted",
    },
  });

  return db.$transaction(async (tx) => {
    const ids = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM mail_outbox WHERE "expiresAt" > ${now} AND attempts < 5 AND ((status = 'pending' AND "nextAttemptAt" <= ${now}) OR (status = 'processing' AND "leaseUntil" < ${now})) ORDER BY "createdAt", id FOR UPDATE SKIP LOCKED LIMIT 1`;

    if (!ids[0]) {
      return null;
    }

    return tx.mailOutbox.update({
      where: { id: ids[0].id },
      data: {
        status: "processing",
        attempts: { increment: 1 },
        leaseToken: randomUUID(),
        leaseUntil: new Date(now.getTime() + 60_000),
      },
    });
  });
}

export type MailJob = NonNullable<Awaited<ReturnType<typeof claimMail>>>;

export async function deliverMail(
  db: Database,
  job: MailJob,
  key: string,
  send: MailSender,
) {
  await db.$transaction(
    async (tx) => {
      // Resend/revoke must wait for an already started bounded SMTP delivery.
      const owned = await tx.$queryRaw<
        { id: string }[]
      >`SELECT id FROM mail_outbox WHERE id = ${job.id} AND revision = ${job.revision} AND "leaseToken" = ${job.leaseToken} AND status = 'processing' FOR UPDATE`;

      if (!owned.length) {
        return;
      }

      const current = await tx.mailOutbox.findUniqueOrThrow({
        where: { id: job.id },
      });

      if (current.expiresAt.getTime() <= Date.now()) {
        await tx.mailOutbox.update({
          where: { id: job.id },
          data: {
            payload: null,
            status: "cancelled",
            leaseToken: null,
            leaseUntil: null,
          },
        });

        return;
      }

      const payload = openMail(
        current.payload ?? "",
        current.id,
        current.revision,
        key,
      );

      await send(payload, `${current.id}.${current.revision}`);
      await tx.mailOutbox.update({
        where: { id: job.id },
        data: {
          status: "sent",
          payload: null,
          leaseToken: null,
          leaseUntil: null,
          lastError: null,
          sentAt: new Date(),
        },
      });
    },
    { timeout: 12000 },
  );
}

export async function retryMail(db: Database, job: MailJob, now = new Date()) {
  const dead = job.attempts >= 5;

  await db.mailOutbox.updateMany({
    where: {
      id: job.id,
      revision: job.revision,
      leaseToken: job.leaseToken,
      status: "processing",
    },
    data: {
      status: dead ? "dead" : "pending",
      ...(dead ? { payload: null } : {}),
      leaseToken: null,
      leaseUntil: null,
      lastError: dead ? "attempts_exhausted" : "delivery_failed",
      nextAttemptAt: new Date(
        now.getTime() + Math.min(300_000, 1000 * 2 ** job.attempts),
      ),
    },
  });
}

export async function runMail(db: Database, key: string, send: MailSender) {
  const job = await claimMail(db);

  if (!job) {
    return false;
  }

  try {
    await deliverMail(db, job, key, send);
  } catch {
    await retryMail(db, job);
  }

  return true;
}
