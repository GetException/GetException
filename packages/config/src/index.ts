import { z } from "zod";
import { parseGitlabTrust } from "./gitlab-ci";

export { parseGitlabTrust, gitlabTrustSchema } from "./gitlab-ci";

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
      GITLAB_CI_TRUST: z.string().max(65536).optional(),
    })
    .parse(env);

  if (config.GITLAB_CI_TRUST) {
    parseGitlabTrust(config.GITLAB_CI_TRUST);
  }

  if (
    config.DASHBOARD_ORIGIN === config.INGEST_ORIGIN ||
    new URL(config.DASHBOARD_ORIGIN).hostname ===
      new URL(config.INGEST_ORIGIN).hostname
  ) {
    throw new Error("Dashboard and ingest must use different hosts");
  }

  if (
    new Set([
      config.TOTP_ENCRYPTION_KEY,
      config.AUTH_RATE_KEY,
      config.BETTER_AUTH_SECRET,
    ]).size !== 3
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

const loopbackHosts = new Set(["localhost", "127.0.0.1", "[::1]"]);

export function isLoopbackOrigin(value: string): boolean {
  try {
    const url = new URL(value);

    return (
      ["http:", "https:"].includes(url.protocol) &&
      url.origin === value &&
      loopbackHosts.has(url.hostname)
    );
  } catch {
    return false;
  }
}

export function canonicalOrigin(value: string, allowLocal = false): string {
  const url = new URL(value);

  if (
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.hostname.includes("*") ||
    url.pathname !== "/" ||
    (url.protocol !== "https:" &&
      !(
        allowLocal &&
        url.protocol === "http:" &&
        loopbackHosts.has(url.hostname)
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
