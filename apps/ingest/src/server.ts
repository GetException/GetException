import { BucketLimiter } from "./bucket-limiter";
import { readEnvelopeBody, respond } from "./http";
import { createServer } from "node:http";
import { createHash, randomUUID } from "node:crypto";
import { type IngestDatabase, Prisma, assertSchema } from "@getexception/db";
import {
  BoundaryError,
  parseEnvelope,
  sanitizeEvent,
} from "@getexception/protocol";

export interface IngestOptions {
  origin: string;
  trustedProxy?: boolean;
}

const hash = (text: string) => createHash("sha256").update(text).digest("hex");

export async function inboxReadiness(db: IngestDatabase) {
  const rollback = new Error("rollback_probe");

  try {
    await db.$transaction(async (tx) => {
      await tx.eventInbox.createMany({
        data: {
          id: randomUUID(),
          projectId: null,
          eventId: "00000000000000000000000000000000",
          payload: {},
        },
      });

      throw rollback;
    });
  } catch (error) {
    if (error !== rollback) {
      throw error;
    }
  }
}

export function createIngestServer(db: IngestDatabase, options: IngestOptions) {
  const limiter = new BucketLimiter();
  const server = createServer(
    {
      maxHeaderSize: 16_384,
      requestTimeout: 10_000,
      headersTimeout: 5000,
      keepAliveTimeout: 5000,
    },
    (req, res) => {
      void (async () => {
        if (req.url === "/health/live") {
          return respond(res, 200);
        }

        if (req.url === "/health/ready") {
          try {
            await assertSchema(db);
            await inboxReadiness(db);
            respond(res, 200);
          } catch {
            respond(res, 503);
          }

          return;
        }

        const url = new URL(req.url ?? "/", options.origin);
        const match = /^\/api\/([a-f0-9-]{36})\/envelope\/$/.exec(url.pathname);

        if (!match || !["POST", "OPTIONS"].includes(req.method ?? "")) {
          return respond(res, 404);
        }

        const ip = options.trustedProxy
          ? String(req.headers["x-real-ip"] ?? "unknown")
          : (req.socket.remoteAddress ?? "unknown");

        if (
          !limiter.take(
            `ip:${hash(ip)}`,
            req.headers.origin ? 10 : 2,
            req.headers.origin ? 30 : 5,
          )
        ) {
          return respond(res, 429);
        }

        const duplicate = [
          "origin",
          "content-type",
          "content-encoding",
          "x-sentry-auth",
          "authorization",
        ].some(
          (header) =>
            req.rawHeaders.filter(
              (h, index) => index % 2 === 0 && h.toLowerCase() === header,
            ).length > 1,
        );

        if (duplicate || req.headers.authorization) {
          return respond(res, 400);
        }

        if (
          options.trustedProxy &&
          req.headers["x-forwarded-proto"] !== "https"
        ) {
          return respond(res, 400);
        }

        const queryKeys = url.searchParams.getAll("sentry_key");
        const authHeader = req.headers["x-sentry-auth"];

        if (queryKeys.length > 1 || (queryKeys.length && authHeader)) {
          return respond(res, 400);
        }

        let key = queryKeys[0];

        if (typeof authHeader === "string") {
          const matches = [
            ...authHeader.matchAll(
              /(?:^Sentry\s+|,\s*)sentry_key=([a-f0-9]{64})(?=,|$)/g,
            ),
          ];

          if (matches.length !== 1) {
            return respond(res, 400);
          }

          key = matches[0]![1];
        }

        if (!key || !/^[a-f0-9]{64}$/.test(key)) {
          return respond(res, 403);
        }

        try {
          const configs = await db.ingestionConfig.findMany({
            where: { projectId: match[1], keyHash: hash(key) },
            take: 100,
          });

          if (!configs.length) {
            return respond(res, 403);
          }

          const origin = req.headers.origin;

          if (origin && !configs.some((config) => config.origin === origin)) {
            return respond(res, 403);
          }

          if (origin) {
            res.setHeader("Access-Control-Allow-Origin", origin);
            res.setHeader("Vary", "Origin");
          }

          if (req.method === "OPTIONS") {
            if (req.headers["access-control-request-method"] !== "POST") {
              return respond(res, 400);
            }

            const requested = String(
              req.headers["access-control-request-headers"] ?? "",
            )
              .toLowerCase()
              .split(",")
              .map((s) => s.trim())
              .filter(Boolean);

            if (
              requested.some(
                (header) => !["content-type", "x-sentry-auth"].includes(header),
              )
            ) {
              return respond(res, 400);
            }

            res.setHeader("Access-Control-Allow-Methods", "POST");
            res.setHeader(
              "Access-Control-Allow-Headers",
              "Content-Type, X-Sentry-Auth",
            );

            return respond(res, 200);
          }

          if (!limiter.take(`project:${match[1]}`, 20, 50)) {
            return respond(res, 429);
          }

          const encoding = req.headers["content-encoding"];

          if (encoding && encoding !== "identity") {
            return respond(res, 415);
          }

          if (
            ![
              "application/x-sentry-envelope",
              "text/plain",
              "application/octet-stream",
            ].includes(String(req.headers["content-type"] ?? "").split(";")[0]!)
          ) {
            return respond(res, 415);
          }

          const envelope = parseEnvelope(await readEnvelopeBody(req));
          const event = sanitizeEvent(
            envelope.event,
            envelope.eventId,
            Date.now() / 1000,
            configs[0]!.allowedTags,
          );

          // createMany avoids RETURNING: ingest has INSERT but no SELECT permission on inbox.
          await db.eventInbox.createMany({
            data: {
              id: randomUUID(),
              projectId: match[1]!,
              eventId: event.eventId,
              payload: event as unknown as Prisma.InputJsonValue,
            },
            skipDuplicates: true,
          });
          respond(res, 200);
        } catch (error) {
          if (error instanceof BoundaryError) {
            return respond(res, error.reason === "too_large" ? 413 : 400);
          }

          // PostgreSQL admission trigger uses a fixed check-violation code, never echoes its input.
          if (
            error instanceof Prisma.PrismaClientKnownRequestError &&
            ["P2004", "P2010", "P2039"].includes(error.code) &&
            JSON.stringify(error.meta ?? {}).includes("ingest_capacity")
          ) {
            return respond(res, 429);
          }

          respond(res, 503);
        }
      })().catch(() => respond(res, 400));
    },
  );

  server.maxConnections = 200;

  return server;
}
