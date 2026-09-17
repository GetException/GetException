import type { Database } from "@getexception/db";
import { SourceMapStore } from "@getexception/source-maps";

const cursors = new Map<string, string>();

export async function retainSourceMaps(
  db: Database,
  store = new SourceMapStore(),
  now = new Date(),
) {
  const abandoned = new Date(now.getTime() - 86400_000);
  const unused = new Date(now.getTime() - 30 * 86400_000);
  // Filter before LIMIT so long-lived active releases cannot starve cleanup.
  const candidates = await db.$queryRaw<
    { id: string }[]
  >`SELECT u.id FROM source_map_upload u WHERE (u.status IN ('receiving','failed') AND u."updatedAt" < ${abandoned}) OR (u.status = 'ready' AND u."createdAt" < ${unused} AND NOT EXISTS (SELECT 1 FROM error_event e WHERE e."projectId" = u."projectId" AND e.release = u.release) AND NOT EXISTS (SELECT 1 FROM event_inbox q WHERE q."projectId" = u."projectId" AND q.status IN ('pending','processing') AND q.payload->>'release' = u.release)) ORDER BY u."createdAt" LIMIT 10`;
  const uploads = await db.sourceMapUpload.findMany({
    where: { id: { in: candidates.map(({ id }) => id) } },
  });

  for (const upload of uploads) {
    if (
      upload.status === "ready" &&
      (await db.errorEvent.count({
        where: { projectId: upload.projectId, release: upload.release },
      }))
    ) {
      continue;
    }

    await db.sourceMapUpload.deleteMany({
      where: {
        id: upload.id,
        status: upload.status,
        updatedAt: upload.updatedAt,
      },
    });
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
        data: { sourceMapsState: "missing" },
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
