import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient, Prisma } from "../generated/client";
import { PrismaClient as IngestPrismaClient } from "../generated-ingest/client";

export { PrismaClient, Prisma } from "../generated/client";

export type IngestDatabase = IngestPrismaClient;

export function createIngestDatabase(url: string) {
  return new IngestPrismaClient({
    adapter: new PrismaPg({
      connectionString: url,
      options: "-c timezone=UTC",
      max: 10,
      connectionTimeoutMillis: 3000,
    }),
    log: [],
  });
}

export type Database = PrismaClient;

export type Transaction = Prisma.TransactionClient;

export function createDatabase(url: string) {
  return new PrismaClient({
    adapter: new PrismaPg({
      connectionString: url,
      options: "-c timezone=UTC",
      max: 10,
      connectionTimeoutMillis: 3000,
      idleTimeoutMillis: 10_000,
    }),
    log: [],
  });
}

export async function assertSchema(db: PrismaClient | IngestPrismaClient) {
  const schema = await db.runtimeSchema.findFirst();

  if (schema?.version !== 3) {
    throw new Error("Database migrations are required");
  }
}
