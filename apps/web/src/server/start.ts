import { createServer } from "node:http";
import next from "next";
import { assertSchema } from "@getexception/db";
import { logCode } from "@getexception/config";
import { getRuntime } from "./runtime";

async function main() {
  const { db } = getRuntime();

  await assertSchema(db); // Fail closed BEFORE binding any HTTP port.
  const port = Number(process.env.PORT ?? 3000);
  const host = process.env.BIND_HOST ?? "0.0.0.0";
  const app = next({
    dev: process.env.NODE_ENV !== "production",
    dir: "apps/web",
    hostname: host,
    port,
  });

  await app.prepare();
  const handler = app.getRequestHandler();
  const server = createServer(
    { maxHeaderSize: 16_384, requestTimeout: 15_000, headersTimeout: 5000 },
    (req, res) => {
      void handler(req, res);
    },
  );

  server.listen(port, host);
  logCode("web", "started");
  const stop = () =>
    server.close(() => {
      void app
        .close()
        .then(() => db.$disconnect())
        .then(() => logCode("web", "stopped"));
    });

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch(() => {
  logCode("web", "unavailable");
  process.exitCode = 1;
});
