import { z } from "zod";

const mailEnabled = z
  .enum(["true", "false"])
  .default("true")
  .transform((value) => value === "true");

const httpsOrigin = z
  .string()
  .url()
  .refine((value) => {
    const url = new URL(value);

    return (
      url.protocol === "https:" &&
      url.origin === value &&
      !url.username &&
      !url.password
    );
  }, "Use an exact HTTPS origin");

export function webConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const config = z
    .object({
      DATABASE_URL: z.string().min(1),
      DASHBOARD_ORIGIN: httpsOrigin,
      INGEST_ORIGIN: httpsOrigin,
      BETTER_AUTH_SECRET: z.string().min(32),
      TOTP_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
      AUTH_RATE_KEY: z.string().regex(/^[a-f0-9]{64}$/),
      MAIL_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
      MAIL_ENABLED: mailEnabled,
    })
    .parse(env);

  if (
    config.DASHBOARD_ORIGIN === config.INGEST_ORIGIN ||
    new URL(config.DASHBOARD_ORIGIN).hostname ===
      new URL(config.INGEST_ORIGIN).hostname
  ) {
    throw new Error("Dashboard and ingest must use different hosts");
  }

  if (
    [
      config.TOTP_ENCRYPTION_KEY,
      config.AUTH_RATE_KEY,
      config.BETTER_AUTH_SECRET,
    ].includes(config.MAIL_ENCRYPTION_KEY) ||
    config.TOTP_ENCRYPTION_KEY === config.AUTH_RATE_KEY ||
    config.TOTP_ENCRYPTION_KEY === config.BETTER_AUTH_SECRET
  ) {
    throw new Error("Use separate encryption and authentication keys");
  }

  return config;
}

export function workerConcurrency(
  value = process.env.WORKER_CONCURRENCY ?? "4",
) {
  return z.coerce.number().int().min(1).max(16).parse(value);
}

export function mailConfig(
  env: Record<string, string | undefined> = process.env,
) {
  const base = z
    .object({
      DATABASE_URL: z.string().min(1),
      MAIL_ENCRYPTION_KEY: z.string().regex(/^[a-f0-9]{64}$/),
      MAIL_ENABLED: mailEnabled,
    })
    .parse(env);

  if (!base.MAIL_ENABLED) {
    return { ...base, MAIL_ENABLED: false as const };
  }

  const config = z
    .object({
      SMTP_HOST: z.string().min(1),
      SMTP_PORT: z.coerce.number().int().min(1).max(65535),
      SMTP_MODE: z.enum(["tls", "starttls", "local"]).default("starttls"),
      SMTP_USER: z.string().optional(),
      SMTP_PASSWORD: z.string().optional(),
      SMTP_FROM: z.string().email(),
    })
    .parse(env);

  if (
    config.SMTP_MODE === "local" &&
    !["127.0.0.1", "localhost", "mailpit"].includes(config.SMTP_HOST)
  ) {
    throw new Error("Unencrypted SMTP is limited to the local mail catcher");
  }

  return { ...base, ...config, MAIL_ENABLED: true as const };
}

export function canonicalOrigin(value: string, allowLocal = false): string {
  const url = new URL(value);

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        allowLocal &&
        url.protocol === "http:" &&
        ["localhost", "127.0.0.1"].includes(url.hostname)
      ))
  ) {
    throw new Error("Invalid origin");
  }

  return url.origin;
}

/** Emit only known codes; callers must never pass arbitrary Error objects or payloads. */
export function logCode(
  component: "web" | "ingest" | "worker",
  code: "started" | "stopped" | "unavailable" | "retry" | "dead_letter",
) {
  process.stdout.write(
    JSON.stringify({ component, code, at: new Date().toISOString() }) + "\n",
  );
}
