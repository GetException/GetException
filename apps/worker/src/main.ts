import { createServer } from "node:http";
import { setTimeout } from "node:timers/promises";
import { createDatabase, assertSchema } from "@getexception/db";
import { workerConcurrency, logCode } from "@getexception/config";
import { queueMetrics, retainBatch, runOne } from "./events";

async function main() {
  const mode = process.env.WORKER_MODE ?? "worker-events";

  if (!["worker-events", "worker-retention"].includes(mode)) {
    throw new Error("Invalid worker mode");
  }

  const concurrency = workerConcurrency();
  const db = createDatabase(process.env.DATABASE_URL ?? "");

  await assertSchema(db);
  let stopping = false;
  const controller = new AbortController();
  const server = createServer((req, res) => {
    void (async () => {
      res.setHeader("Content-Type", "application/json");

      if (req.url === "/health/live") {
        res.end('{"ok":true}');

        return;
      }

      if (!["/health/ready", "/metrics"].includes(req.url ?? "")) {
        res.writeHead(404).end();

        return;
      }

      try {
        await assertSchema(db);
        const metrics = await queueMetrics(db);

        res.writeHead(stopping ? 503 : 200).end(JSON.stringify(metrics));
      } catch {
        res.writeHead(503).end('{"ok":false}');
      }
    })();
  });

  server.listen(
    Number(process.env.PORT ?? 3002),
    process.env.BIND_HOST ?? "0.0.0.0",
  );
  const stop = () => {
    stopping = true;
    controller.abort();
    server.close();
  };

  process.once("SIGTERM", stop);
  process.once("SIGINT", stop);
  logCode("worker", "started");

  async function loop() {
    while (!stopping) {
      try {
        const worked =
          mode === "worker-events" ? await runOne(db) : await retainBatch(db);

        if (!worked || mode === "worker-retention") {
          await setTimeout(mode === "worker-events" ? 300 : 10_000, undefined, {
            signal: controller.signal,
          }).catch(() => {});
        }
      } catch {
        logCode("worker", "unavailable");
        await setTimeout(1000, undefined, { signal: controller.signal }).catch(
          () => {},
        );
      }
    }
  }

  await Promise.all(
    Array.from({ length: mode === "worker-events" ? concurrency : 1 }, loop),
  );
  await db.$disconnect();
  logCode("worker", "stopped");
}

main().catch(() => {
  logCode("worker", "unavailable");
  process.exitCode = 1;
});
