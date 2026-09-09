import { spawn, type ChildProcess } from "node:child_process";
import { createServer } from "node:net";
import { existsSync } from "node:fs";
import { resolve, join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { temporaryDatabase } from "../tests/integration/database";
import { token, digest } from "../apps/web/src/server/crypto";

async function port() {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  if (!address || typeof address === "string") {
    throw new Error("No test port");
  }

  await new Promise<void>((resolve) => server.close(() => resolve()));

  return address.port;
}

export async function startStack() {
  const caddy = process.env.CADDY_BINARY ?? resolve(".artifacts/tools/caddy");

  if (!existsSync(caddy)) {
    throw new Error(
      "Set CADDY_BINARY to a verified Caddy 2.10.2 binary; see docs/testing.md",
    );
  }

  const database = await temporaryDatabase();
  const children: ChildProcess[] = [];
  const [webPort, ingestPort, workerPort, proxyPort] = await Promise.all([
    port(),
    port(),
    port(),
    port(),
  ]);
  const origin = `https://monitor.localhost:${proxyPort}`,
    ingestOrigin = `https://ingest.monitor.localhost:${proxyPort}`;
  const setupToken = token();

  await database.admin.bootstrapToken.create({
    data: {
      tokenHash: digest(setupToken),
      expiresAt: new Date(Date.now() + 3600_000),
    },
  });
  const env = {
    ...process.env,
    NODE_ENV: "production" as const,
    NEXT_TELEMETRY_DISABLED: "1",
    DASHBOARD_ORIGIN: origin,
    INGEST_ORIGIN: ingestOrigin,
    BETTER_AUTH_SECRET: token(),
    TOTP_ENCRYPTION_KEY: token(),
    AUTH_RATE_KEY: token(),
    MAIL_ENCRYPTION_KEY: token(),
  };

  function launch(args: string[], vars: Record<string, string>) {
    const child = spawn(process.execPath, args, {
      env: { ...env, ...vars },
      stdio: "ignore",
    });

    children.push(child);

    return child;
  }

  async function ready(child: ChildProcess, at: number) {
    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null) {
        throw new Error("A test runtime exited before readiness");
      }

      try {
        const result = await fetch(`http://127.0.0.1:${at}/health/ready`);

        if (result.ok) {
          return;
        }
      } catch {
        /* Runtime is still starting. */
      }

      await setTimeout(200);
    }

    throw new Error("Test runtime did not become ready");
  }

  async function cleanup() {
    for (const child of children) {
      child.kill("SIGTERM");
    }

    await Promise.all(
      children.map((child) =>
        child.exitCode !== null
          ? Promise.resolve()
          : new Promise<void>((resolve) => {
              const timer = globalThis.setTimeout(() => {
                child.kill("SIGKILL");
                resolve();
              }, 10_000);

              child.once("exit", () => {
                clearTimeout(timer);
                resolve();
              });
            }),
      ),
    );
    await database.cleanup();
  }

  try {
    const web = launch(["apps/web/dist/start.js"], {
      DATABASE_URL: database.urls.web,
      PORT: String(webPort),
    });
    const ingest = launch(["apps/ingest/dist/main.js"], {
      DATABASE_URL: database.urls.ingest,
      PORT: String(ingestPort),
      TRUST_PROXY: "1",
    });
    const worker = launch(["apps/worker/dist/main.js"], {
      DATABASE_URL: database.urls.worker,
      PORT: String(workerPort),
      WORKER_CONCURRENCY: "2",
    });

    await Promise.all([
      ready(web, webPort),
      ready(ingest, ingestPort),
      ready(worker, workerPort),
    ]);
    const proxy = spawn(
      caddy,
      ["run", "--config", "docker/Caddyfile", "--adapter", "caddyfile"],
      {
        env: {
          ...process.env,
          XDG_DATA_HOME: join(database.directory, "caddy-data"),
          XDG_CONFIG_HOME: join(database.directory, "caddy-config"),
          DASHBOARD_HOST: `monitor.localhost:${proxyPort}`,
          INGEST_HOST: `ingest.monitor.localhost:${proxyPort}`,
          BROWSER_FIXTURE_HOST: `browser.monitor.localhost:${proxyPort}`,
          REACT_FIXTURE_HOST: `react.monitor.localhost:${proxyPort}`,
          WEB_UPSTREAM: `127.0.0.1:${webPort}`,
          INGEST_UPSTREAM: `127.0.0.1:${ingestPort}`,
          BROWSER_ROOT: resolve("fixtures/browser-spa/dist"),
          REACT_ROOT: resolve("fixtures/react-spa/dist"),
        },
        stdio: "ignore",
      },
    );

    children.push(proxy);
    await setTimeout(600);

    if (proxy.exitCode !== null) {
      throw new Error("Caddy test proxy failed");
    }

    return {
      origin,
      ingestOrigin,
      browserOrigin: `https://browser.monitor.localhost:${proxyPort}`,
      reactOrigin: `https://react.monitor.localhost:${proxyPort}`,
      setupToken,
      database,
      cleanup,
    };
  } catch (error) {
    await cleanup();

    throw error;
  }
}
