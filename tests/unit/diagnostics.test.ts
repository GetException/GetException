import { expect, it } from "vitest";
import {
  encodeEnvelope,
  parseEnvelope,
  sanitizeEvent,
  sanitizeApiContext,
} from "@getexception/protocol";
import { browserContext } from "../../packages/browser/src/browser-context";

it("keeps bounded API diagnostics across the SDK/ingest sanitization boundary", () => {
  const event = sanitizeEvent(
    {
      message: "Request failed",
      contexts: {
        api: {
          code: "error.request",
          reason: "rate_limited",
          status_code: 429,
          response: "secret",
        },
        browser: { name: "Chrome", major: 140, userAgent: "private raw UA" },
      },
    },
    "a".repeat(32),
  );
  const envelope = parseEnvelope(
    new TextEncoder().encode(encodeEnvelope(event)),
  );
  const stored = sanitizeEvent(envelope.event, envelope.eventId);

  expect(stored.api).toEqual({
    code: "error.request",
    reason: "rate_limited",
    status_code: 429,
  });
  expect(stored.browser).toEqual({ name: "Chrome", major: 140 });
  expect(JSON.stringify(stored)).not.toMatch(/secret|private raw UA/);
  expect(
    sanitizeApiContext({
      code: "email@example.test",
      reason: "free form private text",
      status_code: 600,
    }),
  ).toBeUndefined();
});

it.each([
  [
    "Mozilla/5.0 Chrome/140.1.2.3 Safari/537.36 Edg/141.2.3.4",
    { name: "Edge", major: 141 },
  ],
  ["Mozilla/5.0 Version/18.4 Safari/605.1.15", { name: "Safari", major: 18 }],
  ["Firefox/131.6", { name: "Firefox", major: 131 }],
  ["Unknown browser", undefined],
])("extracts only family and major from %s", (ua, expected) => {
  expect(browserContext(ua)).toEqual(expected);
});
