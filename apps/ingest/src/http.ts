import type { IncomingMessage, ServerResponse } from "node:http";
import { BoundaryError, LIMITS } from "@getexception/protocol";

export function respond(res: ServerResponse, status: number) {
  res.setHeader("Cache-Control", "no-store");
  res.setHeader("Content-Type", "application/json");
  res.setHeader("X-Content-Type-Options", "nosniff");

  if (status === 429) {
    res.setHeader("Retry-After", "60");
    res.setHeader("X-Sentry-Rate-Limits", "60:error:organization");
  }

  res.writeHead(status).end(JSON.stringify({ accepted: status === 200 }));
}

export async function readEnvelopeBody(req: IncomingMessage) {
  if (Number(req.headers["content-length"] ?? 0) > LIMITS.envelope) {
    throw new BoundaryError("too_large");
  }

  const chunks: Buffer[] = [];
  let size = 0;

  for await (const chunk of req) {
    size += Buffer.byteLength(chunk);

    if (size > LIMITS.envelope) {
      throw new BoundaryError("too_large");
    }

    chunks.push(Buffer.from(chunk));
  }

  return Buffer.concat(chunks);
}
