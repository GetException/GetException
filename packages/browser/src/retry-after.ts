/** RFC 9110 permits either delay-seconds or an HTTP date. Never disable backoff on malformed input. */
export function retryAfterMs(value: string | null, now = Date.now()): number {
  const delay =
    value && /^\d+$/.test(value)
      ? Number(value) * 1000
      : value && /^[A-Za-z]/.test(value)
        ? Date.parse(value) - now
        : NaN;

  return Math.min(
    300_000,
    Math.max(1000, Number.isFinite(delay) ? delay : 60_000),
  );
}
