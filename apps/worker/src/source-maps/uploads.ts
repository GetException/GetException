import { randomUUID } from "node:crypto";
import type { Database } from "@getexception/db";
import { SourceMapStore } from "@getexception/source-maps";
import { parseStoredMap } from "./parse";

export async function validateOneUpload(
  db: Database,
  store = new SourceMapStore(),
) {
  const upload = await db.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<
      { id: string }[]
    >`SELECT u.id FROM source_map_upload u JOIN project p ON p.id = u."projectId" WHERE p."deletedAt" IS NULL AND (u.status = 'pending' OR (u.status = 'validating' AND u."leaseUntil" < now())) ORDER BY u."createdAt" FOR UPDATE OF u SKIP LOCKED LIMIT 1`;

    if (!rows[0]) {
      return null;
    }

    return tx.sourceMapUpload.update({
      where: { id: rows[0].id },
      data: {
        status: "validating",
        attempts: { increment: 1 },
        leaseToken: randomUUID(),
        leaseUntil: new Date(Date.now() + 60_000),
      },
      include: { artifacts: true },
    });
  });

  if (!upload) {
    return false;
  }

  const heartbeat = setInterval(() => {
    void db.sourceMapUpload
      .updateMany({
        where: {
          id: upload.id,
          leaseToken: upload.leaseToken,
          status: "validating",
        },
        data: { leaseUntil: new Date(Date.now() + 60_000) },
      })
      .catch(() => {});
  }, 20_000);
  let valid = upload.attempts <= 3;

  try {
    if (!valid) {
      throw new Error("Attempts exhausted");
    }

    for (const file of upload.artifacts) {
      const owned = await db.sourceMapUpload.updateMany({
        where: {
          id: upload.id,
          leaseToken: upload.leaseToken,
          status: "validating",
        },
        data: { leaseUntil: new Date(Date.now() + 60_000) },
      });

      if (!owned.count) {
        return true;
      }

      if (!file.uploadedAt) {
        throw new Error("Incomplete artifact");
      }

      await parseStoredMap(store, file);
    }
  } catch {
    valid = false;
  } finally {
    clearInterval(heartbeat);
  }

  await db.$transaction(async (tx) => {
    const owned = await tx.$queryRaw<
      { id: string }[]
    >`SELECT id FROM source_map_upload WHERE id = ${upload.id} AND "leaseToken" = ${upload.leaseToken} AND status = 'validating' FOR UPDATE`;

    if (!owned.length) {
      return;
    }

    await tx.sourceMapUpload.update({
      where: { id: upload.id },
      data: {
        status: valid ? "ready" : "failed",
        errorCode: valid ? null : "source_map_invalid",
        leaseUntil: null,
        leaseToken: null,
      },
    });

    if (valid) {
      await tx.release.update({
        where: {
          projectId_name: { projectId: upload.projectId, name: upload.release },
        },
        data: { sourceMapsState: "ready", sourceMapsVersion: { increment: 1 } },
      });
    } else {
      await tx.release.updateMany({
        where: {
          projectId: upload.projectId,
          name: upload.release,
          sourceMapsVersion: 0,
        },
        data: { sourceMapsState: "failed" },
      });
    }

    await tx.$executeRaw`INSERT INTO audit_log(id, action, success) VALUES (${randomUUID()}, 'source_map_validate', ${valid})`;
  });

  return true;
}
