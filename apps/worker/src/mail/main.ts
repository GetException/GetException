import { createServer } from "node:http";
import { setTimeout as delay } from "node:timers/promises";
import { createDatabase, assertSchema } from "@getexception/db";
import { mailConfig, logCode } from "@getexception/config";
import { runMail } from "./queue";
import { smtpSender } from "./smtp";

async function main() {
  const config = mailConfig();
  const db = createDatabase(config.DATABASE_URL);

  await assertSchema(db);
  const send = smtpSender(config);
  let stopping = false;
  const controller = new AbortController();
  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader("Content-Type", "application/json");
      res.setHeader("Cache-Control", "no-store");

      if (req.url === "/health/live") {
        res.end('{"ok":true}');

        return;
      }

      if (req.url !== "/health/ready") {
        res.writeHead(404).end();

        return;
      }

      try {
        await assertSchema(db);
        await db.mailOutbox.count();
        res.writeHead(stopping ? 503 : 200).end('{"ok":true}');
      } catch {
        res.writeHead(503).end('{"ok":false}');
      }
    })();
  });

  server.listen(
    Number(process.env.PORT ?? 3003),
    process.env.BIND_HOST ?? "0.0.0.0",
  );
  const stop = () => {
    stopping = true;
    controller.abort();
    server.close();
  };

  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  logCode("worker", "started");

  while (!stopping) {
    try {
      if (await runMail(db, config.MAIL_ENCRYPTION_KEY, send)) {
        continue;
      }
    } catch {
      logCode("worker", "unavailable");
    }

    await delay(500, undefined, { signal: controller.signal }).catch(() => {});
  }

  await db.$disconnect();
  logCode("worker", "stopped");
}

main().catch(() => {
  logCode("worker", "unavailable");
  process.exitCode = 1;
});
