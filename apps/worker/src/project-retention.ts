import type { Database } from "@getexception/db";

export async function purgeDeletedProjectBatch(db: Database) {
  const [result] = await db.$queryRaw<{ removed: number }[]>`
    SELECT purge_deleted_project_batch() AS removed
  `;

  return result?.removed ?? 0;
}
