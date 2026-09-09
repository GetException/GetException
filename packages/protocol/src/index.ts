import { z } from "zod";
import { BoundaryError, record } from "./json";

export {
  boundedJson,
  BoundaryError,
  LIMITS,
  parseEnvelope,
  record,
} from "./json";

export const safeFrameSchema = z
  .object({
    filename: z.string().max(512),
    function: z.string().max(160),
    lineno: z.number().int().min(0).max(10_000_000),
    colno: z.number().int().min(0).max(10_000_000),
    in_app: z.boolean(),
    debug_id: z.string().uuid().optional(),
  })
  .strict();

export const safeBreadcrumbSchema = z
  .object({
    category: z.enum(["navigation", "http", "manual"]),
    timestamp: z.number(),
    data: z
      .object({
        path: z.string().max(512).optional(),
        method: z
          .enum(["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"])
          .optional(),
        status_code: z.number().int().min(100).max(599).optional(),
        duration: z.number().min(0).max(300_000).optional(),
        operation: z.string().max(120).optional(),
      })
      .strict(),
  })
  .strict();

export const safeEventSchema = z
  .object({
    eventId: z.string().regex(/^[a-f0-9]{32}$/),
    timestamp: z.number(),
    level: z.enum(["error", "fatal"]),
    message: z.string().max(1024),
    exceptionType: z.string().max(120),
    handled: z.boolean(),
    environment: z.enum(["production", "staging", "development"]),
    release: z.string().max(160).optional(),
    dist: z.string().max(64).optional(),
    route: z.string().max(512).optional(),
    frames: z.array(safeFrameSchema).max(100),
    tags: z.record(z.string().max(32), z.string().max(120)),
    breadcrumbs: z.array(safeBreadcrumbSchema).max(50),
  })
  .strict();

export type SafeEvent = z.infer<typeof safeEventSchema>;

export type SafeFrame = z.infer<typeof safeFrameSchema>;

export type SafeBreadcrumb = z.infer<typeof safeBreadcrumbSchema>;

export const DEFAULT_TAGS = ["feature", "component", "operation"] as const;

export function scrub(value: unknown, max = 1024): string {
  if (typeof value !== "string") {
    return "";
  }

  return (
    value
      .slice(0, Math.min(max, 4096))
      // eslint-disable-next-line no-control-regex -- Remove ANSI escape sequences from untrusted text.
      .replace(/\x1b\[[0-9;]*[A-Za-z]/g, "")
      // eslint-disable-next-line no-control-regex -- Strip controls before storage or display.
      .replace(/[\x00-\x1f\x7f]/g, " ")
      .replace(/https?:\/\/[^\s<>"']+/gi, (url) => safePath(url) ?? "[url]")
      .replace(/\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/gi, "[email]")
      .replace(/\b(?:bearer\s+)[a-z0-9._~+/-]+=*/gi, "[token]")
      .replace(
        /\b(?:password|passwd|secret|token|api[_-]?key|authorization)\s*[:=]\s*[^\s,;]+/gi,
        "[redacted]",
      )
      .replace(
        /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
        "[token]",
      )
      .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, "[ip]")
      .replace(/\b[A-Fa-f0-9]{32,}\b/g, "[identifier]")
  );
}

export function safePath(value: unknown): string | undefined {
  if (typeof value !== "string" || value.length > 4096) {
    return undefined;
  }

  try {
    const url = new URL(value, "https://path.invalid");

    if (!["http:", "https:", "webpack:"].includes(url.protocol)) {
      return undefined;
    }

    // Decode before scrubbing to prevent encoded email/token path fragments.
    return (
      decodeURIComponent(url.pathname)
        .slice(0, 512)
        // eslint-disable-next-line no-control-regex -- URL paths must not contain control characters.
        .replace(/[\x00-\x1f\x7f]/g, "")
        .replace(/\b[\w.%+-]+@[\w.-]+\.[a-z]{2,}\b/gi, "[email]")
        .replace(/\b[A-Fa-f0-9]{24,}\b/g, "[identifier]")
        .replace(
          /\/(?:token|secret|password|api[_-]?key)\/[^/]+/gi,
          "/[redacted]",
        )
        .replace(
          /\beyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/g,
          "[token]",
        )
    );
  } catch {
    return undefined;
  }
}

const integer = (value: unknown) =>
  typeof value === "number" &&
  Number.isInteger(value) &&
  value >= 0 &&
  value <= 10_000_000
    ? value
    : 0;

function boundedTime(value: unknown, now: number): number {
  return typeof value === "number" &&
    Number.isFinite(value) &&
    value >= now - 7 * 86400 &&
    value <= now + 300
    ? value
    : now;
}

export function sanitizeTags(
  value: unknown,
  allowed: readonly string[] = DEFAULT_TAGS,
): Record<string, string> {
  const out: Record<string, string> = Object.create(null);
  const input = record(value);

  for (const key of allowed.slice(0, 50)) {
    if (
      !/^[a-z][a-z0-9_]{0,31}$/.test(key) ||
      ["constructor", "prototype", "__proto__"].includes(key)
    ) {
      continue;
    }

    if (
      typeof input[key] === "string" ||
      typeof input[key] === "number" ||
      typeof input[key] === "boolean"
    ) {
      out[key] = scrub(String(input[key]), 120);
    }
  }

  return out;
}

export function sanitizeBreadcrumb(
  value: unknown,
  now = Date.now() / 1000,
): SafeBreadcrumb | undefined {
  const input = record(value);
  const data = record(input.data);

  if (!["navigation", "http", "manual"].includes(String(input.category))) {
    return undefined;
  }

  const out: SafeBreadcrumb = {
    category: input.category as SafeBreadcrumb["category"],
    timestamp: boundedTime(input.timestamp, now),
    data: {},
  };
  const path = safePath(data.path ?? data.url ?? data.to);

  if (path) {
    out.data.path = path;
  }

  if (
    ["GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"].includes(
      String(data.method),
    )
  ) {
    out.data.method = data.method as SafeBreadcrumb["data"]["method"];
  }

  if (integer(data.status_code) >= 100 && integer(data.status_code) <= 599) {
    out.data.status_code = Number(data.status_code);
  }

  if (
    typeof data.duration === "number" &&
    data.duration >= 0 &&
    data.duration <= 300_000
  ) {
    out.data.duration = data.duration;
  }

  if (typeof data.operation === "string") {
    out.data.operation = scrub(data.operation, 120);
  }

  return out;
}

export function sanitizeEvent(
  value: unknown,
  eventId: string,
  now = Date.now() / 1000,
  allowedTags: readonly string[] = DEFAULT_TAGS,
): SafeEvent {
  const input = record(value);

  if (
    input.type !== undefined ||
    (input.level !== undefined &&
      input.level !== "error" &&
      input.level !== "fatal")
  ) {
    throw new BoundaryError("unsupported");
  }

  const values = record(input.exception).values;
  const exception = record(
    Array.isArray(values) ? values[values.length - 1] : undefined,
  );
  const rawFrames = record(exception.stacktrace).frames;
  const frames: SafeFrame[] = [];

  for (const value of (Array.isArray(rawFrames) ? rawFrames : []).slice(-100)) {
    const frame = record(value);
    const filename = safePath(frame.filename);

    if (!filename) {
      continue;
    }

    const safe: SafeFrame = {
      filename,
      function: scrub(frame.function, 160),
      lineno: integer(frame.lineno),
      colno: integer(frame.colno),
      in_app: frame.in_app !== false,
    };

    if (
      typeof frame.debug_id === "string" &&
      z.string().uuid().safeParse(frame.debug_id).success
    ) {
      safe.debug_id = frame.debug_id;
    }

    frames.push(safe);
  }

  const rawBreadcrumbs = Array.isArray(input.breadcrumbs)
    ? input.breadcrumbs
    : record(input.breadcrumbs).values;
  const breadcrumbs = (Array.isArray(rawBreadcrumbs) ? rawBreadcrumbs : [])
    .slice(-50)
    .map((b) => sanitizeBreadcrumb(b, now))
    .filter((b): b is SafeBreadcrumb => Boolean(b));
  const out: SafeEvent = {
    eventId,
    timestamp: boundedTime(input.timestamp, now),
    level: input.level === "fatal" ? "fatal" : "error",
    message:
      scrub(
        exception.value ?? input.message ?? record(input.logentry).formatted,
      ) || "Unknown error",
    exceptionType: scrub(exception.type, 120) || "Error",
    handled: record(exception.mechanism).handled !== false,
    environment:
      input.environment === "production" || input.environment === "staging"
        ? input.environment
        : "development",
    frames,
    tags: sanitizeTags(input.tags, allowedTags),
    breadcrumbs,
  };

  if (
    typeof input.release === "string" &&
    /^[a-z0-9][a-z0-9-]{0,79}@[a-f0-9]{40}$/.test(input.release)
  ) {
    out.release = input.release;
  }

  if (
    typeof input.dist === "string" &&
    /^[a-zA-Z0-9._-]{1,64}$/.test(input.dist)
  ) {
    out.dist = input.dist;
  }

  const route = safePath(record(record(input.contexts).app).route);

  if (route) {
    out.route = route;
  }

  return safeEventSchema.parse(out);
}

export function toSentryEvent(event: SafeEvent) {
  return {
    event_id: event.eventId,
    timestamp: event.timestamp,
    platform: "javascript",
    level: event.level,
    environment: event.environment,
    release: event.release,
    dist: event.dist,
    sdk: { name: "getexception.javascript.browser", version: "0.1.0" },
    exception: {
      values: [
        {
          type: event.exceptionType,
          value: event.message,
          mechanism: { type: "generic", handled: event.handled },
          stacktrace: { frames: event.frames },
        },
      ],
    },
    tags: event.tags,
    breadcrumbs: event.breadcrumbs,
    contexts: event.route ? { app: { route: event.route } } : {},
  };
}

export function encodeEnvelope(event: SafeEvent): string {
  const item = JSON.stringify(toSentryEvent(event));

  return `${JSON.stringify({ event_id: event.eventId })}\n${JSON.stringify({ type: "event", length: new TextEncoder().encode(item).length })}\n${item}`;
}
