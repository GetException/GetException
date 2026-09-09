import { randomUUID } from "node:crypto";
import type { Transaction } from "@getexception/db";
import { sealMail, type MailPayload } from "@getexception/mail";

export async function queueInvitationMail(
  tx: Transaction,
  invitationId: string,
  kind: "invitation" | "verification",
  payload: MailPayload,
  expiresAt: Date,
  key: string,
) {
  const previous = await tx.mailOutbox.findUnique({
    where: { invitationId_kind: { invitationId, kind } },
  });
  const id = previous?.id ?? randomUUID();
  const revision = (previous?.revision ?? 0) + 1;
  const data = {
    revision,
    payload: sealMail(payload, id, revision, key),
    expiresAt,
    status: "pending",
    attempts: 0,
    nextAttemptAt: new Date(),
    leaseToken: null,
    leaseUntil: null,
    lastError: null,
    sentAt: null,
  };

  await tx.mailOutbox.upsert({
    where: { id },
    create: { id, invitationId, kind, ...data },
    update: data,
  });
}

export async function cancelInvitationMail(
  tx: Transaction,
  invitationId: string,
) {
  await tx.mailOutbox.updateMany({
    where: { invitationId, status: { in: ["pending", "processing"] } },
    data: {
      payload: null,
      status: "cancelled",
      leaseToken: null,
      leaseUntil: null,
    },
  });
}
