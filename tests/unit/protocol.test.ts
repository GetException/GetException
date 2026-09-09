import { describe, expect, it } from "vitest";
import { randomBytes } from "node:crypto";
import {
  boundedJson,
  encodeEnvelope,
  LIMITS,
  parseEnvelope,
  sanitizeEvent,
  safePath,
  scrub,
} from "@getexception/protocol";

const id = "a".repeat(32);
const bytes = (value: string) => new TextEncoder().encode(value);

describe("bounded protocol", () => {
  it.each([
    '{"x":1,"x":2}',
    '{"__proto__":{}}',
    '{"nested":{"constructor":1}}',
    '{"prototype":1}',
    '{"x":01}',
    "[1,]",
    '{"x":NaN}',
    '"unterminated',
    "true false",
  ])("rejects malformed or dangerous JSON %s", (value) => {
    expect(() => boundedJson(value)).toThrow();
  });
  it("enforces nesting, arrays, strings and fields before unbounded allocation", () => {
    for (const input of [
      "[".repeat(20) + "0" + "]".repeat(20),
      JSON.stringify(Array(513).fill(0)),
      JSON.stringify("a".repeat(4097)),
      JSON.stringify(
        Object.fromEntries(
          Array.from({ length: 2050 }, (_, i) => [String(i), 0]),
        ),
      ),
    ]) {
      expect(() => boundedJson(input)).toThrow();
    }

    expect(() => boundedJson(" ".repeat(LIMITS.item + 1))).toThrow();
  });
  it("roundtrips bounded Unicode and Sentry byte lengths", () => {
    const event = sanitizeEvent(
      { exception: { values: [{ type: "Error", value: "Ошибка 💡" }] } },
      id,
    );
    const parsed = parseEnvelope(bytes(encodeEnvelope(event)));

    expect(sanitizeEvent(parsed.event, parsed.eventId).message).toBe(
      "Ошибка 💡",
    );
  });
  it("rejects extra items, wrong length, mismatched IDs, invalid UTF8 and unsupported items", () => {
    const valid = encodeEnvelope(sanitizeEvent({ message: "hello" }, id));

    for (const input of [
      valid + '\n{"type":"event"}\n{}',
      valid.replace('"event"', '"transaction"'),
      valid.replace('"length":', '"length":99999,"duplicate":'),
      valid.replace(`"event_id":"${id}"`, `"event_id":"${"b".repeat(32)}"`),
    ]) {
      expect(() => parseEnvelope(bytes(input))).toThrow();
    }

    expect(() =>
      parseEnvelope(new Uint8Array([255, 10, 255, 10, 255])),
    ).toThrow();
  });
  it("independently drops sensitive data and scrubs permitted strings", () => {
    const canary = randomBytes(18).toString("hex");
    const input = {
      event_id: id,
      message: `token=${canary}`,
      user: { email: `${canary}@example.com` },
      request: {
        headers: { authorization: canary },
        cookies: canary,
        data: canary,
      },
      extra: { value: canary },
      contexts: {
        arbitrary: { secret: canary },
        app: { route: `/editor?token=${canary}#${canary}` },
      },
      tags: { secret: canary, feature: "editor" },
      breadcrumbs: [
        { category: "console", message: canary },
        {
          category: "http",
          data: {
            url: `https://example.com/api?token=${canary}`,
            headers: { secret: canary },
            method: "GET",
            status_code: 500,
          },
        },
      ],
      exception: {
        values: [
          {
            type: "Error",
            value: `password=${canary}`,
            stacktrace: {
              frames: [
                {
                  filename: `https://example.com/app.js?token=${canary}`,
                  function: "render",
                  lineno: 2,
                  colno: 3,
                  vars: { secret: canary },
                  pre_context: [canary],
                },
              ],
            },
          },
        ],
      },
    };
    const event = sanitizeEvent(input, id);
    const serialized = JSON.stringify(event);

    expect(serialized.includes(canary)).toBe(false);
    expect(event.route).toBe("/editor");
    expect(event.frames[0]?.filename).toBe("/app.js");
    expect(event.tags).toEqual({ feature: "editor" });
    expect(event.breadcrumbs).toHaveLength(1);
  });
  it("keeps XSS and SQL as inert text, never executable URLs", () => {
    const text = "<img src=x onerror=alert(1)>'); DROP TABLE user; --";

    expect(sanitizeEvent({ message: text }, id).message).toBe(text);
    expect(safePath("javascript:alert(1)")).toBeUndefined();
    expect(safePath("data:text/html,<script>1</script>")).toBeUndefined();
    expect(safePath("https://app.invalid/token/aSensitiveValue/editor")).toBe(
      "/[redacted]/editor",
    );
    expect(scrub("owner@example.com 127.0.0.1 Bearer abcdef")).toBe(
      "[email] [ip] [token]",
    );
  });
  it("bounds timestamps, release, tags and stack frame counts", () => {
    const result = sanitizeEvent(
      {
        timestamp: 999999999999,
        release: "main",
        environment: "unknown",
        exception: {
          values: [
            {
              stacktrace: {
                frames: Array.from({ length: 101 }, () => ({
                  filename: "https://app.invalid/a.js",
                })),
              },
            },
          ],
        },
      },
      id,
      1000,
    );

    expect(result.timestamp).toBe(1000);
    expect(result.release).toBeUndefined();
    expect(result.frames).toHaveLength(100);
    expect(() => sanitizeEvent({ type: "transaction" }, id)).toThrow();
    expect(() => sanitizeEvent({ level: "info" }, id)).toThrow();
  });
  it("handles a deterministic malformed-input corpus without prototype mutation", () => {
    let seed = 13;
    const chars = '{}[]",:012truefalse\\\n';

    for (let n = 0; n < 500; n++) {
      let input = "";

      for (let i = 0; i < n % 80; i++) {
        seed = (seed * 16807) % 2147483647;
        input += chars[seed % chars.length];
      }

      try {
        boundedJson(input);
      } catch {
        /* Invalid corpus members are expected. */
      }
    }

    expect(Object.prototype).not.toHaveProperty("polluted");
  });
});
