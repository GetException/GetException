import { createIngestDatabase, assertSchema } from "@getexception/db";
import { logCode } from "@getexception/config";
import { createIngestServer, inboxReadiness } from "./server";

async function main() {
  const db = createIngestDatabase(process.env.DATABASE_URL ?? "");

  await assertSchema(db);
  await inboxReadiness(db);
  const server = createIngestServer(db, {
    origin: process.env.INGEST_ORIGIN ?? "https://ingest.monitor.localhost",
    trustedProxy: process.env.TRUST_PROXY === "1",
  });

  server.listen(
    Number(process.env.PORT ?? 3001),
    process.env.BIND_HOST ?? "0.0.0.0",
  );
  logCode("ingest", "started");
  const stop = () => {
    server.close(() => {
      void db.$disconnect().then(() => logCode("ingest", "stopped"));
    });
  };

  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
}

main().catch(() => {
  logCode("ingest", "unavailable");
  process.exitCode = 1;
});
