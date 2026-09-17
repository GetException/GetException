import * as Sentry from "@getexception/sentry-browser";
import { version } from "../package.json";
import { browserContext } from "./browser-context";
import { scriptDebugId } from "./debug-ids";
import {
  encodeEnvelope,
  sanitizeBreadcrumb,
  sanitizeEvent,
  sanitizeTags,
  safePath,
  sanitizeApiContext,
  type ApiContext,
  toSentryEvent,
  type SafeBreadcrumb,
} from "@getexception/protocol";

export type SeverityLevel = "error" | "fatal";

export type { ApiContext, BrowserContext } from "@getexception/protocol";

export interface CaptureContext {
  contexts?: { api?: ApiContext };
}

export interface BrowserOptions {
  dsn: string;
  release?: string;
  environment?: "production" | "staging" | "development";
  dist?: string;
  enabled?: boolean;
}

export interface Breadcrumb {
  category?: string;
  timestamp?: number;
  data?: Record<string, unknown>;
}

export interface Scope {
  setTag(key: string, value: string | number | boolean): void;
  setTags(tags: Record<string, string | number | boolean>): void;
  setContext(name: string, context: Record<string, unknown> | null): void;
  addBreadcrumb(breadcrumb: Breadcrumb): void;
}

let active = false;
const pending = new Set<Promise<unknown>>();
const controllers = new Set<AbortController>();
const maxTimeout = (timeout?: number) =>
  Math.min(2000, Math.max(0, timeout ?? 1500));
let backoffUntil = 0;

export function dsnEndpoint(dsn: string): string {
  const url = new URL(dsn);

  if (
    url.protocol !== "https:" ||
    url.password ||
    url.search ||
    url.hash ||
    !/^[a-f0-9]{64}$/.test(url.username) ||
    !/^\/[a-f0-9-]{36}$/.test(url.pathname)
  ) {
    throw new Error("GetException requires an HTTPS DSN");
  }

  return `${url.origin}/api${url.pathname}/envelope/?sentry_key=${url.username}&sentry_version=7`;
}

/** Unsupported options are ignored; only this allow-list is ever passed to Sentry. */
export function init(options?: BrowserOptions): void {
  try {
    if (active || !options || options.enabled === false) {
      return;
    }

    const endpoint = dsnEndpoint(options.dsn);
    const browser =
      typeof navigator === "undefined"
        ? undefined
        : browserContext(navigator.userAgent);
    // Sentry's internal DSN validator accepts numeric project IDs only. The
    // custom transport below always targets the original GetException UUID.
    const internalDsn = new URL(options.dsn);

    internalDsn.pathname = "/1";
    Sentry.init({
      dsn: internalDsn.toString(),
      release: options.release,
      environment: options.environment,
      dist: options.dist,
      defaultIntegrations: false,
      integrations: [
        Sentry.globalHandlersIntegration(),
        Sentry.browserApiErrorsIntegration(),
      ],
      sendDefaultPii: false,
      maxBreadcrumbs: 50,
      beforeBreadcrumb: (breadcrumb) =>
        (sanitizeBreadcrumb(breadcrumb) as SafeBreadcrumb | null) ?? null,
      beforeSend: (event) => {
        try {
          for (const exception of event.exception?.values ?? []) {
            for (const frame of exception.stacktrace?.frames ?? []) {
              const debugId = scriptDebugId(frame.filename);

              if (debugId) {
                frame.debug_id = debugId;
              }
            }
          }

          return {
            ...toSentryEvent(
              sanitizeEvent(
                {
                  ...event,
                  contexts: {
                    ...event.contexts,
                    ...(browser ? { browser } : {}),
                  },
                },
                event.event_id ?? "",
              ),
              version,
            ),
            type: undefined,
          };
        } catch {
          return null;
        }
      },
      transport: () => ({
        send: async (envelope) => {
          if (!active || Date.now() < backoffUntil || pending.size >= 30) {
            return { statusCode: 429 };
          }

          try {
            const items = envelope[1];

            if (items.length !== 1 || items[0]?.[0].type !== "event") {
              return { statusCode: 400 };
            }

            const payload = items[0][1];
            const eventId =
              typeof payload === "object" &&
              payload !== null &&
              "event_id" in payload
                ? String(payload.event_id)
                : "";
            const body = encodeEnvelope(
              sanitizeEvent(payload, eventId),
              version,
            );
            const controller = new AbortController();

            controllers.add(controller);
            const timer = setTimeout(() => controller.abort(), 2000);
            const request = fetch(endpoint, {
              method: "POST",
              body,
              headers: { "Content-Type": "application/x-sentry-envelope" },
              credentials: "omit",
              referrerPolicy: "no-referrer",
              redirect: "error",
              signal: controller.signal,
            })
              .then((response) => {
                if (response.status === 429) {
                  backoffUntil =
                    Date.now() +
                    Math.min(
                      300_000,
                      Math.max(
                        1000,
                        Number(response.headers.get("retry-after") ?? 60) *
                          1000,
                      ),
                    );
                }

                return { statusCode: response.status };
              })
              .catch(() => ({ statusCode: 0 }))
              .finally(() => {
                clearTimeout(timer);
                controllers.delete(controller);
                pending.delete(request);
              });

            pending.add(request);

            return await request;
          } catch {
            return { statusCode: 0 };
          }
        },
        flush: (timeout) => waitPending(maxTimeout(timeout)),
      }),
    });
    active = true;
  } catch {
    active = false;
  }
}

function guarded<T>(fn: () => T, fallback: T): T {
  if (!active) {
    return fallback;
  }

  try {
    return fn();
  } catch {
    return fallback;
  }
}

export function captureException(
  exception: unknown,
  context?: CaptureContext,
): string {
  return guarded(() => {
    const api = sanitizeApiContext(context?.contexts?.api);

    return api
      ? Sentry.captureException(exception, { contexts: { api } })
      : Sentry.captureException(exception);
  }, "");
}

/** Unsupported levels explicitly produce no event and return an empty ID. */
export function captureMessage(
  message: string,
  level: SeverityLevel = "error",
): string {
  return ["error", "fatal"].includes(level)
    ? guarded(() => Sentry.captureMessage(message, level), "")
    : "";
}

export function setTag(key: string, value: string | number | boolean): void {
  setTags({ [key]: value });
}

export function setTags(tags: Record<string, string | number | boolean>): void {
  guarded(() => Sentry.setTags(sanitizeTags(tags)), undefined);
}

export function setContext(
  name: string,
  context: Record<string, unknown> | null,
): void {
  if (name !== "app" && name !== "api") {
    return;
  }

  guarded(() => {
    if (name === "api") {
      Sentry.setContext("api", sanitizeApiContext(context) ?? null);

      return;
    }

    const route = safePath(context?.route);

    Sentry.setContext("app", route ? { route } : null);
  }, undefined);
}

export function addBreadcrumb(breadcrumb: Breadcrumb): void {
  guarded(() => {
    const safe = sanitizeBreadcrumb(breadcrumb);

    if (safe) {
      Sentry.addBreadcrumb(safe);
    }
  }, undefined);
}

export function withScope<T>(callback: (scope: Scope) => T): T {
  // Application callbacks always run; their exceptions retain normal application semantics.
  if (!active) {
    return callback({ setTag, setTags, setContext, addBreadcrumb });
  }

  return Sentry.withScope((scope) =>
    callback({
      setTag: (key, value) => {
        scope.setTags(sanitizeTags({ [key]: value }));
      },
      setTags: (tags) => {
        scope.setTags(sanitizeTags(tags));
      },
      setContext: (name, context) => {
        if (name === "api") {
          scope.setContext(name, sanitizeApiContext(context) ?? null);
        }

        if (name === "app") {
          const route = safePath(context?.route);

          scope.setContext(name, route ? { route } : null);
        }
      },
      addBreadcrumb: (breadcrumb) => {
        const safe = sanitizeBreadcrumb(breadcrumb);

        if (safe) {
          scope.addBreadcrumb(safe);
        }
      },
    }),
  );
}

async function waitPending(timeout: number): Promise<boolean> {
  let timer: ReturnType<typeof setTimeout> | undefined;

  try {
    return await Promise.race([
      Promise.allSettled([...pending]).then(() => true),
      new Promise<false>((resolve) => {
        timer = setTimeout(() => resolve(false), timeout);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

export async function flush(timeout?: number): Promise<boolean> {
  if (!active) {
    return true;
  }

  try {
    return await Sentry.flush(maxTimeout(timeout));
  } catch {
    return false;
  }
}

export async function close(timeout?: number): Promise<boolean> {
  if (!active) {
    return true;
  }

  try {
    return await Sentry.close(maxTimeout(timeout));
  } catch {
    return false;
  } finally {
    active = false;

    for (const controller of controllers) {
      controller.abort();
    }
  }
}
