import type { Database } from "@getexception/db";

export async function retainExpiredAuth(db: Database) {
  await db.$queryRaw`SELECT purge_expired_auth_batch() AS done`;
}
