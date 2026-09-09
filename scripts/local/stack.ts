import { existsSync, writeFileSync } from "node:fs";
import { request } from "node:https";
import { join, resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import type { ChildProcess } from "node:child_process";
import { startLocalDatabase } from "./database";
import { startMailpit } from "./mail";
import {
  databaseUrl,
  LocalError,
  localOrigins,
  localWebConfig,
  type LocalState,
} from "./state";
import { launch, ready, requireFreePort, stopChild } from "./processes";

function probeHttps(port: number) {
  return new Promise<boolean>((resolve) => {
    const req = request(
      {
        hostname: "127.0.0.1",
        servername: "monitor.localhost",
        port,
        path: "/",
        headers: { Host: `monitor.localhost:${port}` },
        rejectUnauthorized: false,
      },
      (res) => {
        res.resume();
        res.once("end", () => resolve(res.statusCode === 307));
      },
    );

    req.setTimeout(1000, () => req.destroy());
    req.once("error", () => resolve(false));
    req.end();
  });
}

export async function startLocalStack(directory: string, state: LocalState) {
  const caddy = process.env.CADDY_BINARY ?? resolve(".artifacts/tools/caddy");

  for (const file of [
    caddy,
    "apps/web/.next/BUILD_ID",
    "apps/web/dist/start.js",
    "apps/ingest/dist/main.js",
    "apps/worker/dist/main.js",
    "apps/worker/dist/mail.js",
    "fixtures/browser-spa/dist/index.html",
    "fixtures/react-spa/dist/index.html",
  ]) {
    if (!existsSync(file)) {
      throw new LocalError(
        "Build the application with yarn checks and provide CADDY_BINARY before starting; see docs/local-preview.md.",
      );
    }
  }

  await Promise.all(Object.values(state.ports).map(requireFreePort));
  const database = await startLocalDatabase(directory, state);
  const children: ChildProcess[] = [];
  let stopped = false;
  const stop = async () => {
    if (stopped) {
      return;
    }

    stopped = true;
    await Promise.all(children.map((child) => stopChild(child)));
    await database.stop();
  };
  const origins = localOrigins(state);

  try {
    children.push(await startMailpit(directory, state));
    const base = { BIND_HOST: "127.0.0.1" };
    const web = launch(process.execPath, ["apps/web/dist/start.js"], {
      ...base,
      ...localWebConfig(state),
      PORT: String(state.ports.web),
    });
    const ingest = launch(process.execPath, ["apps/ingest/dist/main.js"], {
      ...base,
      DATABASE_URL: databaseUrl(state, "ingest"),
      INGEST_ORIGIN: origins.ingest,
      TRUST_PROXY: "1",
      PORT: String(state.ports.ingest),
    });
    const worker = launch(process.execPath, ["apps/worker/dist/main.js"], {
      ...base,
      DATABASE_URL: databaseUrl(state, "worker"),
      WORKER_CONCURRENCY: "2",
      PORT: String(state.ports.worker),
    });
    const retention = launch(process.execPath, ["apps/worker/dist/main.js"], {
      ...base,
      DATABASE_URL: databaseUrl(state, "worker"),
      WORKER_MODE: "worker-retention",
      PORT: String(state.ports.retention),
    });

    children.push(web, ingest, worker, retention);
    const mail = launch(process.execPath, ["apps/worker/dist/mail.js"], {
      ...base,
      DATABASE_URL: databaseUrl(state, "mail"),
      MAIL_ENCRYPTION_KEY: state.secrets.MAIL_ENCRYPTION_KEY,
      SMTP_HOST: "127.0.0.1",
      SMTP_PORT: String(state.ports.smtp),
      SMTP_MODE: "local",
      SMTP_FROM: "getexception@example.test",
      PORT: String(state.ports.mail),
    });

    children.push(mail);
    await Promise.all([
      ready(web, state.ports.web, "Web"),
      ready(ingest, state.ports.ingest, "Ingest"),
      ready(worker, state.ports.worker, "Worker"),
      ready(retention, state.ports.retention, "Retention"),
      ready(mail, state.ports.mail, "Mail worker"),
    ]);
    const proxy = launch(
      caddy,
      ["run", "--config", "docker/Caddyfile", "--adapter", "caddyfile"],
      {
        CADDY_BIND: "127.0.0.1",
        XDG_DATA_HOME: join(directory, "caddy-data"),
        XDG_CONFIG_HOME: join(directory, "caddy-config"),
        DASHBOARD_HOST: new URL(origins.dashboard).host,
        INGEST_HOST: new URL(origins.ingest).host,
        BROWSER_FIXTURE_HOST: new URL(origins.browser).host,
        REACT_FIXTURE_HOST: new URL(origins.react).host,
        WEB_UPSTREAM: `127.0.0.1:${state.ports.web}`,
        INGEST_UPSTREAM: `127.0.0.1:${state.ports.ingest}`,
        BROWSER_ROOT: resolve("fixtures/browser-spa/dist"),
        REACT_ROOT: resolve("fixtures/react-spa/dist"),
      },
    );

    children.push(proxy);
    let readyProxy = false;

    for (let attempt = 0; attempt < 50; attempt++) {
      if (proxy.exitCode !== null || proxy.signalCode !== null || !proxy.pid) {
        break;
      }

      if (await probeHttps(state.ports.https)) {
        readyProxy = true;
        break;
      }

      await delay(200);
    }

    if (!readyProxy) {
      throw new LocalError("The local HTTPS proxy did not become ready.");
    }

    writeFileSync(
      join(directory, "address.json"),
      JSON.stringify(origins, null, 2) + "\n",
      { mode: 0o600 },
    );

    return {
      stop,
      origins,
      installed: database.installed,
      children: [...children, database.child],
    };
  } catch (error) {
    await stop();

    throw error;
  }
}
