import { randomBytes, createHash } from "node:crypto";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";

if (existsSync(".env")) {
  throw new Error(".env already exists; existing secrets were preserved");
}

const fresh = () => randomBytes(32).toString("hex");
const setupToken = fresh();
const names = [
  "POSTGRES_PASSWORD",
  "MIGRATE_PASSWORD",
  "WEB_PASSWORD",
  "INGEST_PASSWORD",
  "WORKER_PASSWORD",
  "BACKUP_PASSWORD",
  "MAIL_PASSWORD",
  "MAIL_ENCRYPTION_KEY",
  "BETTER_AUTH_SECRET",
  "TOTP_ENCRYPTION_KEY",
  "AUTH_RATE_KEY",
];
const env = names.map((name) => `${name}=${fresh()}`);

env.push(
  `SETUP_TOKEN_HASH=${createHash("sha256").update(setupToken).digest("hex")}`,
  "NPM_TOKEN=",
  "DASHBOARD_HOST=monitor.localhost",
  "INGEST_HOST=ingest.monitor.localhost",
  "WORKER_CONCURRENCY=4",
  "IMAGE_TAG=local",
);
writeFileSync(".env", env.join("\n") + "\n", { mode: 0o600, flag: "wx" });
mkdirSync("runtime", { recursive: true, mode: 0o700 });
writeFileSync("runtime/setup-token", setupToken, { mode: 0o600, flag: "wx" });
process.stdout.write(
  "Created .env (0600). Read the one-time token from runtime/setup-token, open https://monitor.localhost/setup, then delete that file after setup.\n",
);
