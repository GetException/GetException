import EmbeddedPostgres from "embedded-postgres";
import pg from "pg";
import { createServer } from "node:net";
import { createRequire } from "node:module";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { randomBytes } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createDatabase } from "@getexception/db";

export async function temporaryDatabase() {
  process.umask(0o077);
  const external = process.env.INTEGRATION_ADMIN_URL;
  const directory = mkdtempSync(join(tmpdir(), "getexception-pg-"));
  let embedded: EmbeddedPostgres | undefined;
  let adminUrl = external;

  if (!external) {
    // Audited postinstall: recreates relative symlinks only inside the pinned binary package.
    const require = createRequire(import.meta.url);
    const binary = require.resolve(
      `@embedded-postgres/${process.platform}-${process.arch}`,
    );
    const packageDir = resolve(dirname(binary), "..");
    const hydrate = spawnSync(
      process.execPath,
      [join(packageDir, "scripts/hydrate-symlinks.js")],
      { cwd: packageDir, stdio: "ignore" },
    );

    if (hydrate.status !== 0) {
      throw new Error("Unable to prepare PostgreSQL test binaries");
    }

    const listener = createServer();

    await new Promise<void>((resolve, reject) => {
      listener.once("error", reject);
      listener.listen(0, "127.0.0.1", resolve);
    });
    const address = listener.address();

    if (!address || typeof address === "string") {
      throw new Error("No test port");
    }

    const port = address.port;

    await new Promise<void>((resolve) => listener.close(() => resolve()));
    const password = randomBytes(32).toString("hex");

    embedded = new EmbeddedPostgres({
      databaseDir: join(directory, "data"),
      port,
      user: "postgres",
      password,
      authMethod: "scram-sha-256",
      persistent: true,
      createPostgresUser: false,
      postgresFlags: [
        "-h",
        "127.0.0.1",
        "-k",
        directory,
        "-c",
        "log_statement=none",
        "-c",
        "log_min_error_statement=panic",
      ],
      onLog: () => {},
      onError: () => {},
    });
    await embedded.initialise();
    await embedded.start();
    await embedded.createDatabase("getexception_test");
    adminUrl = `postgresql://postgres:${password}@127.0.0.1:${port}/getexception_test`;
  }

  if (!adminUrl || !new URL(adminUrl).pathname.endsWith("_test")) {
    throw new Error(
      "Integration database must end in _test and use an isolated cluster",
    );
  }

  const client = new pg.Client({ connectionString: adminUrl });

  await client.connect();
  const existing = await client.query(
    "SELECT 1 FROM pg_roles WHERE rolname = 'getexception_web'",
  );

  if (existing.rowCount) {
    throw new Error(
      "Refusing to modify existing runtime roles; use an empty test cluster",
    );
  }

  const roles = [
    "migrate",
    "web",
    "ingest",
    "worker",
    "backup",
    "mail",
  ] as const;
  const urls = {} as Record<(typeof roles)[number], string>;

  for (const role of roles) {
    const password = randomBytes(32).toString("hex");

    await client.query(
      "SELECT set_config('getexception.test_role', $1, false), set_config('getexception.test_password', $2, false)",
      [`getexception_${role}`, password],
    );
    await client.query(
      "DO $$ BEGIN EXECUTE format('CREATE ROLE %I LOGIN PASSWORD %L NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS CONNECTION LIMIT 40', current_setting('getexception.test_role'), current_setting('getexception.test_password')); END $$",
    );
    const url = new URL(adminUrl);

    url.username = `getexception_${role}`;
    url.password = password;
    urls[role] = url.toString();
  }

  await client.query(
    "REVOKE ALL ON SCHEMA public FROM PUBLIC; ALTER SCHEMA public OWNER TO getexception_migrate",
  );
  await client.end();
  const migration = spawnSync(
    "corepack",
    ["yarn", "prisma", "migrate", "deploy"],
    {
      cwd: process.cwd(),
      env: { ...process.env, DATABASE_URL: urls.migrate },
      encoding: "utf8",
    },
  );

  if (migration.status !== 0) {
    process.stderr.write(migration.stderr);

    throw new Error("Test migration failed");
  }

  const admin = createDatabase(adminUrl);

  return {
    directory,
    admin,
    urls,
    adminUrl,
    cleanup: async () => {
      await admin.$disconnect();

      if (embedded) {
        await embedded.stop();
        rmSync(directory, { recursive: true, force: true });
      }
    },
  };
}

export const migrationFiles = () =>
  [
    "202609070001_initial",
    "202609070002_boundaries",
    "202609080003_issue_workflow",
    "202609080004_members_invitations",
  ].map((name) =>
    readFileSync(
      join("packages/db/prisma/migrations", name, "migration.sql"),
      "utf8",
    ),
  );
