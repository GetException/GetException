import { randomBytes } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { join } from "node:path";
import { z } from "zod";

export class LocalError extends Error {}

const secret = z.string().regex(/^[a-f0-9]{64}$/);
const port = z.number().int().min(1024).max(65535);

const legacyStateSchema = z
  .object({
    version: z.literal(1),
    initialized: z.boolean(),
    ports: z
      .object({
        https: port,
        database: port,
        web: port,
        ingest: port,
        worker: port,
        retention: port,
      })
      .strict(),
    passwords: z
      .object({
        postgres: secret,
        migrate: secret,
        web: secret,
        ingest: secret,
        worker: secret,
        backup: secret,
      })
      .strict(),
    secrets: z
      .object({
        BETTER_AUTH_SECRET: secret,
        TOTP_ENCRYPTION_KEY: secret,
        AUTH_RATE_KEY: secret,
      })
      .strict(),
  })
  .strict();

const mailStateSchema = legacyStateSchema
  .extend({
    version: z.literal(2),
    mailInitialized: z.boolean(),
    ports: legacyStateSchema.shape.ports.extend({
      mail: port,
      smtp: port,
      mailUi: port,
    }),
    passwords: legacyStateSchema.shape.passwords.extend({ mail: secret }),
    secrets: legacyStateSchema.shape.secrets.extend({
      MAIL_ENCRYPTION_KEY: secret,
    }),
  })
  .strict();

export const stateSchema = legacyStateSchema.extend({ version: z.literal(3) });

export type LocalState = z.infer<typeof stateSchema>;

export const freshSecret = () => randomBytes(32).toString("hex");

export function privateDirectory(directory: string) {
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  chmodSync(directory, 0o700);
}

export function saveState(directory: string, state: LocalState) {
  const path = join(directory, "config.json");

  writeFileSync(path + ".next", JSON.stringify(state, null, 2) + "\n", {
    mode: 0o600,
  });
  chmodSync(path + ".next", 0o600);
  renameSync(path + ".next", path);
}

export async function availablePort() {
  const server = createServer();

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();

  await new Promise<void>((resolve) => server.close(() => resolve()));

  if (!address || typeof address === "string") {
    throw new LocalError("Unable to allocate a local port.");
  }

  return address.port;
}

export async function loadState(
  directory: string,
  httpsPort = 8443,
): Promise<LocalState> {
  privateDirectory(directory);
  const file = join(directory, "config.json");

  if (existsSync(file)) {
    let result: ReturnType<typeof stateSchema.safeParse>;

    try {
      const raw: unknown = JSON.parse(readFileSync(file, "utf8"));
      const legacy = z
        .union([legacyStateSchema, mailStateSchema])
        .safeParse(raw);

      if (legacy.success) {
        if (
          legacy.data.initialized &&
          !existsSync(join(directory, "data", "PG_VERSION"))
        ) {
          throw new LocalError(
            "Saved PostgreSQL data is missing. Restore runtime/local from backup.",
          );
        }

        const upgraded: LocalState = {
          version: 3,
          initialized: legacy.data.initialized,
          ports: legacyStateSchema.shape.ports.strip().parse(legacy.data.ports),
          passwords: legacyStateSchema.shape.passwords
            .strip()
            .parse(legacy.data.passwords),
          secrets: legacyStateSchema.shape.secrets
            .strip()
            .parse(legacy.data.secrets),
        };

        saveState(directory, upgraded);
        result = stateSchema.safeParse(upgraded);
      } else {
        result = stateSchema.safeParse(raw);
      }
    } catch {
      throw new LocalError(
        "Local configuration is invalid. Existing data and keys were preserved.",
      );
    }

    if (!result.success) {
      throw new LocalError(
        "Local configuration is invalid. Existing data and keys were preserved.",
      );
    }

    if (
      result.data.initialized &&
      !existsSync(join(directory, "data", "PG_VERSION"))
    ) {
      throw new LocalError(
        "Saved PostgreSQL data is missing. Restore runtime/local from backup; a new database was not created.",
      );
    }

    chmodSync(file, 0o600);

    return result.data;
  }

  if (existsSync(join(directory, "data"))) {
    throw new LocalError(
      "Database files exist without their configuration. Restore config.json; encryption keys were not regenerated.",
    );
  }

  if (!port.safeParse(httpsPort).success) {
    throw new LocalError("LOCAL_HTTPS_PORT must be between 1024 and 65535.");
  }

  const allocated = new Set([httpsPort]);

  async function nextPort() {
    let value: number;

    do {
      value = await availablePort();
    } while (allocated.has(value));

    allocated.add(value);

    return value;
  }

  const state: LocalState = {
    version: 3,
    initialized: false,
    ports: {
      https: httpsPort,
      database: await nextPort(),
      web: await nextPort(),
      ingest: await nextPort(),
      worker: await nextPort(),
      retention: await nextPort(),
    },
    passwords: {
      postgres: freshSecret(),
      migrate: freshSecret(),
      web: freshSecret(),
      ingest: freshSecret(),
      worker: freshSecret(),
      backup: freshSecret(),
    },
    secrets: {
      BETTER_AUTH_SECRET: freshSecret(),
      TOTP_ENCRYPTION_KEY: freshSecret(),
      AUTH_RATE_KEY: freshSecret(),
    },
  };

  saveState(directory, state);

  return state;
}

export function databaseUrl(
  state: LocalState,
  role: keyof LocalState["passwords"],
  database = "getexception_local",
) {
  const url = new URL(
    `postgresql://127.0.0.1:${state.ports.database}/${database}`,
  );

  url.username = role === "postgres" ? "postgres" : `getexception_${role}`;
  url.password = state.passwords[role];

  return url.toString();
}

export function localOrigins(state: LocalState) {
  const suffix = `.localhost:${state.ports.https}`;

  return {
    dashboard: `https://monitor${suffix}`,
    ingest: `https://ingest.monitor${suffix}`,
    browser: `https://browser.monitor${suffix}`,
    react: `https://react.monitor${suffix}`,
  };
}

export function localWebConfig(state: LocalState) {
  const origins = localOrigins(state);

  return {
    ...state.secrets,
    DATABASE_URL: databaseUrl(state, "web"),
    DASHBOARD_ORIGIN: origins.dashboard,
    INGEST_ORIGIN: origins.ingest,
  };
}

/** Only operating-system/tooling variables enter child processes; runtime secrets are added per role. */
export function childEnvironment() {
  const env: NodeJS.ProcessEnv = {
    NODE_ENV: "production",
    NEXT_TELEMETRY_DISABLED: "1",
  };

  for (const name of [
    "PATH",
    "HOME",
    "TMPDIR",
    "TMP",
    "TEMP",
    "SystemRoot",
    "WINDIR",
    "PATHEXT",
  ]) {
    if (process.env[name]) {
      env[name] = process.env[name];
    }
  }

  return env;
}
