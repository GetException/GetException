import { createHash } from "node:crypto";
import type { SafeEvent } from "@getexception/protocol";

export function normalizeMessage(message: string) {
  return message
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, "<id>")
    .replace(/\b\d+\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim();
}

export function fingerprint(event: SafeEvent) {
  const frames = event.frames
    .filter((frame) => frame.in_app)
    .slice(-5)
    .map((frame) => [frame.filename, frame.function, frame.lineno]);

  return createHash("sha256")
    .update(
      JSON.stringify([
        event.exceptionType,
        normalizeMessage(event.message),
        frames,
      ]),
    )
    .digest("hex");
}
