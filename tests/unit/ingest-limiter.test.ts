import { afterEach, expect, it, vi } from "vitest";
import { BucketLimiter } from "../../apps/ingest/src/bucket-limiter";

afterEach(() => vi.useRealTimers());

it("bounds tracked clients without evicting active limits, then recovers after idle expiry", () => {
  vi.useFakeTimers();
  const limiter = new BucketLimiter();

  for (let i = 0; i < 20_000; i++) {
    expect(limiter.take(String(i), 1, 1)).toBe(true);
  }

  expect(limiter.take("new", 1, 1)).toBe(false);
  expect(limiter.take("0", 1, 1)).toBe(false);
  vi.advanceTimersByTime(1000);
  expect(limiter.take("0", 1, 1)).toBe(true);
  vi.advanceTimersByTime(60_001);
  expect(limiter.take("new", 1, 1)).toBe(true);
});

it("does not manufacture negative credits when the clock moves backwards", () => {
  vi.useFakeTimers();
  const now = Date.now();
  const limiter = new BucketLimiter();

  expect(limiter.take("client", 1, 2)).toBe(true);
  vi.setSystemTime(now - 5000);
  expect(limiter.take("client", 1, 2)).toBe(true);
  expect(limiter.take("client", 1, 2)).toBe(false);
});
