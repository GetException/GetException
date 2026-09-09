export class BucketLimiter {
  private buckets = new Map<string, { credit: number; at: number }>();

  take(key: string, rate: number, burst: number) {
    const now = Date.now();

    if (this.buckets.size > 20_000) {
      for (const [id, bucket] of this.buckets) {
        if (now - bucket.at > 60_000) {
          this.buckets.delete(id);
        }
      }

      if (this.buckets.size > 20_000 && !this.buckets.has(key)) {
        return false;
      }
    }

    const bucket = this.buckets.get(key) ?? { credit: burst, at: now };

    bucket.credit = Math.min(
      burst,
      bucket.credit + ((now - bucket.at) * rate) / 1000,
    );
    bucket.at = now;
    const allowed = bucket.credit >= 1;

    if (allowed) {
      bucket.credit--;
    }

    this.buckets.set(key, bucket);

    return allowed;
  }
}
