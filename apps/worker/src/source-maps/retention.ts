import { Prisma, type Database } from "@getexception/db";
import { RETENTION_DAYS } from "@getexception/protocol";
import { SourceMapStore } from "@getexception/source-maps";

const cursors = new Map<string, string>();

export async function retainSourceMaps(
  db: Database,
  store = new SourceMapStore(),
  now = new Date(),
) {
  const abandoned = new Date(
    now.getTime() - RETENTION_DAYS.incompleteUploads * 86400_000,
  );
  const unused = new Date(
    now.getTime() - RETENTION_DAYS.sourceMaps * 86400_000,
  );
  const maximum = new Date(
    now.getTime() - RETENTION_DAYS.sourceMapsMaximum * 86400_000,
  );
  const expired = Prisma.sql`
    (u.status IN ('receiving', 'failed', 'pending') AND u."updatedAt" < ${abandoned})
    OR (u.status = 'validating' AND u."updatedAt" < ${abandoned}
      AND (u."leaseUntil" IS NULL OR u."leaseUntil" < ${now}))
    OR (u.status = 'ready' AND u."createdAt" < ${unused}
      AND (u."createdAt" < ${maximum} OR NOT EXISTS (
        SELECT 1 FROM error_event e
        WHERE e."projectId" = u."projectId" AND e.release = u.release
          AND (
            EXISTS (
              SELECT 1 FROM jsonb_array_elements(e.frames) frame
              WHERE frame->>'debug_id' IS NULL
            )
            OR EXISTS (
              SELECT 1 FROM source_artifact a
              JOIN LATERAL jsonb_array_elements(e.frames) frame ON true
              WHERE a."uploadId" = u.id
                AND frame->>'debug_id' = a."debugId"
            )
          )
      ))
      AND NOT EXISTS (
        SELECT 1 FROM event_inbox q
        WHERE q."projectId" = u."projectId"
          AND q.status IN ('pending', 'processing')
          AND q.payload->>'release' = u.release
      ))
  `;
  // Filter before LIMIT so long-lived active releases cannot starve cleanup.
  const candidates = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
    SELECT u.id FROM source_map_upload u
    WHERE ${expired}
    ORDER BY u."createdAt", u.id LIMIT 10
  `);
  const uploads = await db.sourceMapUpload.findMany({
    where: { id: { in: candidates.map(({ id }) => id) } },
  });

  for (const upload of uploads) {
    const removed = await db.$queryRaw<{ id: string }[]>(Prisma.sql`
      DELETE FROM source_map_upload u
      WHERE u.id = ${upload.id}
        AND u.status = ${upload.status}
        AND u."updatedAt" = ${upload.updatedAt}
        AND (${expired})
      RETURNING u.id
    `);

    if (!removed.length || upload.status !== "ready") {
      continue;
    }

    const ready = await db.sourceMapUpload.count({
      where: {
        projectId: upload.projectId,
        release: upload.release,
        status: "ready",
      },
    });

    if (!ready) {
      await db.release.updateMany({
        where: { projectId: upload.projectId, name: upload.release },
        data: { sourceMapsState: "removed" },
      });
    }
  }

  // Metadata always precedes file creation. Project purging can therefore leave
  // only orphan files, never a published file without its database row.
  const names = (await store.entries()).sort();
  const cursor = cursors.get(store.root) ?? "";
  const batch = names.filter((name) => name > cursor).slice(0, 100);

  cursors.set(store.root, batch.length === 100 ? batch[batch.length - 1]! : "");

  await db.$transaction(
    async (tx) => {
      // Serialize reference creation and orphan cleanup: an in-flight manifest
      // may reuse a file whose last committed reference has just expired.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(73104621)`;

      for (const name of batch) {
        if (name.endsWith(".tmp")) {
          await store.removeOrphan(name, abandoned);
        } else if (
          !(await tx.sourceArtifact.findFirst({
            where: { storageId: name.slice(0, -4) },
            select: { id: true },
          }))
        ) {
          await store.removeOrphan(name, now);
        }
      }
    },
    { timeout: 15000 },
  );
}
