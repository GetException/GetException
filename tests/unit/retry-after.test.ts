import { expect, it } from "vitest";
import { retryAfterMs } from "../../packages/browser/src/retry-after";

it("honors bounded delay seconds and HTTP dates", () => {
  const now = Date.UTC(2026, 9, 1);

  expect(retryAfterMs("45", now)).toBe(45_000);
  expect(retryAfterMs(new Date(now + 90_000).toUTCString(), now)).toBe(90_000);
  expect(retryAfterMs(new Date(now - 90_000).toUTCString(), now)).toBe(1000);
  expect(retryAfterMs("0", now)).toBe(1000);
  expect(retryAfterMs("999999", now)).toBe(300_000);
});

it.each([null, "", "invalid", "NaN", "Infinity", "-1", "1.5", "9".repeat(400)])(
  "keeps a safe finite default for malformed Retry-After %s",
  (value) => expect(retryAfterMs(value)).toBe(60_000),
);
