import { spawnSync } from "node:child_process";
import {
  chmodSync,
  statSync,
  existsSync,
  readFileSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { pathToFileURL } from "node:url";
import { setTimeout as delay } from "node:timers/promises";
import pg from "pg";
import { createDatabase } from "@getexception/db";
import { digest } from "../../apps/web/src/server/crypto";
import {
  childEnvironment,
  databaseUrl,
  freshSecret,
  LocalError,
  saveState,
  type LocalState,
} from "./state";
import { launch, requireFreePort, stopChild } from "./processes";

async function postgresBinary() {
  const entry = createRequire(import.meta.url).resolve(
    `@embedded-postgres/${process.platform}-${process.arch}`,
  );
  const directory = join(dirname(entry), "..");
  const result = spawnSync(
    process.execPath,
    [join(directory, "scripts/hydrate-symlinks.js")],
    { env: childEnvironment(), stdio: "ignore" },
  );

  if (result.status !== 0) {
    throw new LocalError(
      "Unable to prepare the installed PostgreSQL binaries.",
    );
  }

  return (await import(pathToFileURL(entry).href)) as {
    postgres: string;
    initdb: string;
  };
}

export async function startLocalDatabase(directory: string, state: LocalState) {
  await requireFreePort(state.ports.database);
  const binaries = await postgresBinary();

  for (const binary of [binaries.postgres, binaries.initdb]) {
    const mode = statSync(binary).mode;

    if ((mode & 0o111) !== 0o111) {
      chmodSync(binary, mode | 0o111);
    }
  }

  const data = join(directory, "data");

  if (!existsSync(join(data, "PG_VERSION"))) {
    if (state.initialized) {
      throw new LocalError(
        "Saved PostgreSQL data is missing; refusing to initialize again.",
      );
    }

    const passwordFile = join(directory, ".init-password");

    writeFileSync(passwordFile, state.passwords.postgres + "\n", {
      mode: 0o600,
      flag: "wx",
    });

    try {
      const result = spawnSync(
        binaries.initdb,
        [
          `--pgdata=${data}`,
          "--auth=scram-sha-256",
          "--username=postgres",
          `--pwfile=${passwordFile}`,
          "--lc-messages=en_US.UTF-8",
        ],
        { env: childEnvironment(), stdio: "ignore" },
      );

      if (result.status !== 0) {
        throw new LocalError(
          "PostgreSQL initialization failed. Existing files were preserved.",
        );
      }
    } finally {
      unlinkSync(passwordFile);
    }
  }

  const child = launch(binaries.postgres, [
    "-D",
    data,
    "-p",
    String(state.ports.database),
    "-h",
    "127.0.0.1",
    "-k",
    "",
    "-c",
    "log_statement=none",
    "-c",
    "log_min_error_statement=panic",
  ]);
  let stopped = false;
  const stop = async () => {
    if (!stopped) {
      stopped = true;
      await stopChild(child, "SIGINT");
    }
  };

  try {
    let connected = false;

    for (let attempt = 0; attempt < 100; attempt++) {
      if (child.exitCode !== null || child.signalCode !== null) {
        break;
      }

      const probe = new pg.Client({
        connectionString: databaseUrl(state, "postgres", "postgres"),
        connectionTimeoutMillis: 500,
      });

      try {
        await probe.connect();
        connected = true;
      } catch {
        /* Starting or recovering. */
      } finally {
        await probe.end();
      }

      if (connected) {
        break;
      }

      await delay(100);
    }

    if (!connected) {
      throw new LocalError(
        "PostgreSQL did not become ready. Saved data was preserved.",
      );
    }

    const bootstrap = new pg.Client({
      connectionString: databaseUrl(state, "postgres", "postgres"),
    });

    await bootstrap.connect();

    try {
      const exists = await bootstrap.query(
        "SELECT 1 FROM pg_database WHERE datname='getexception_local'",
      );

      if (!exists.rowCount) {
        if (state.initialized) {
          throw new LocalError(
            "The saved application database is missing; refusing to recreate it.",
          );
        }

        await bootstrap.query("CREATE DATABASE getexception_local");
      }
    } finally {
      await bootstrap.end();
    }

    const admin = new pg.Client({
      connectionString: databaseUrl(state, "postgres"),
    });

    await admin.connect();

    try {
      await admin.query("BEGIN");

      for (const role of [
        "migrate",
        "web",
        "ingest",
        "worker",
        "backup",
        "mail",
      ] as const) {
        const name = `getexception_${role}`;
        const found = await admin.query(
          "SELECT 1 FROM pg_roles WHERE rolname=$1",
          [name],
        );

        if (!found.rowCount) {
          if (state.initialized && (role !== "mail" || state.mailInitialized)) {
            throw new LocalError(
              "A saved database role is missing; automatic replacement was refused.",
            );
          }

          await admin.query(
            "SELECT set_config('getexception.local_role',$1,true), set_config('getexception.local_password',$2,true)",
            [name, state.passwords[role]],
          );
          await admin.query(
            "DO $$ BEGIN EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 40',current_setting('getexception.local_role'),current_setting('getexception.local_password')); END $$",
          );
        }
      }

      await admin.query(
        "REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO getexception_migrate",
      );
      await admin.query(
        "ALTER ROLE getexception_mail SET statement_timeout = '15s'; ALTER ROLE getexception_mail SET lock_timeout = '3s'; ALTER ROLE getexception_mail SET idle_in_transaction_session_timeout = '15s'",
      );
      await admin.query("COMMIT");
    } finally {
      await admin.end();
    }

    const migrated = spawnSync(
      "corepack",
      ["yarn", "prisma", "migrate", "deploy"],
      {
        env: {
          ...childEnvironment(),
          DATABASE_URL: databaseUrl(state, "migrate"),
        },
        stdio: "ignore",
      },
    );

    if (migrated.status !== 0) {
      throw new LocalError(
        "Database migration failed. Existing data and keys were preserved.",
      );
    }

    const db = createDatabase(databaseUrl(state, "web"));
    let installed: boolean;

    try {
      installed = Boolean(
        await db.systemSetting.findUnique({ where: { id: 1 } }),
      );
      const file = join(directory, "setup-token");

      if (installed) {
        if (existsSync(file)) {
          unlinkSync(file);
        }
      } else {
        let value = existsSync(file) ? readFileSync(file, "utf8").trim() : "";

        if (!/^[a-f0-9]{64}$/.test(value)) {
          value = freshSecret();
          writeFileSync(file, value, { mode: 0o600 });
        }

        await db.bootstrapToken.upsert({
          where: { id: 1 },
          create: {
            tokenHash: digest(value),
            expiresAt: new Date(Date.now() + 86400_000),
          },
          update: {
            tokenHash: digest(value),
            expiresAt: new Date(Date.now() + 86400_000),
          },
        });
      }
    } finally {
      await db.$disconnect();
    }

    state.initialized = true;
    state.mailInitialized = true;
    saveState(directory, state);

    return { stop, installed, child };
  } catch (error) {
    await stop();

    throw error;
  }
}
