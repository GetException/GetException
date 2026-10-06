import type { Database } from "@getexception/db";
import { RETENTION_DAYS } from "@getexception/protocol";

export async function retainReleases(db: Database, now = new Date()) {
  const cutoff = new Date(now.getTime() - RETENTION_DAYS.releases * 86400_000);
  const removed = await db.$queryRaw<{ id: string }[]>`
    WITH candidates AS (
      SELECT r.id
      FROM release r
      WHERE r."lastActivityAt" < ${cutoff}
        AND NOT EXISTS (
          SELECT 1 FROM error_event e
          WHERE e."projectId" = r."projectId" AND e.release = r.name
        )
        AND NOT EXISTS (
          SELECT 1 FROM issue_history h WHERE h."projectId" = r."projectId"
            AND (h."firstRelease" = r.name OR h."lastRelease" = r.name)
        )
        AND NOT EXISTS (
          SELECT 1 FROM source_map_upload u
          WHERE u."projectId" = r."projectId" AND u.release = r.name
        )
        AND NOT EXISTS (
          SELECT 1 FROM event_inbox q
          WHERE q."projectId" = r."projectId"
            AND q.status IN ('pending', 'processing')
            AND q.payload->>'release' = r.name
        )
      ORDER BY r."lastActivityAt", r.id
      LIMIT 100
    )
    DELETE FROM release r USING candidates c
    WHERE r.id = c.id AND r."lastActivityAt" < ${cutoff}
      AND NOT EXISTS (
        SELECT 1 FROM error_event e
        WHERE e."projectId" = r."projectId" AND e.release = r.name
      )
      AND NOT EXISTS (
        SELECT 1 FROM issue_history h WHERE h."projectId" = r."projectId"
          AND (h."firstRelease" = r.name OR h."lastRelease" = r.name)
      )
      AND NOT EXISTS (
        SELECT 1 FROM source_map_upload u
        WHERE u."projectId" = r."projectId" AND u.release = r.name
      )
      AND NOT EXISTS (
        SELECT 1 FROM event_inbox q
        WHERE q."projectId" = r."projectId"
          AND q.status IN ('pending', 'processing')
          AND q.payload->>'release' = r.name
      )
    RETURNING r.id
  `;

  return removed.length;
}
