export type RateLimitDecision =
  | Readonly<{ outcome: "ALLOWED" }>
  | Readonly<{ outcome: "REJECTED"; retryAfterMs: number }>;

export interface RateLimiter {
  consume(key: string): RateLimitDecision;
}

export interface TokenBucketOptions {
  readonly capacity: number;
  readonly refillPerSecond: number;
  readonly now: () => number;
  readonly maxKeys?: number;
}

export function createTokenBucketRateLimiter(options: TokenBucketOptions): RateLimiter {
  if (
    !Number.isFinite(options.capacity) ||
    options.capacity <= 0 ||
    !Number.isFinite(options.refillPerSecond) ||
    options.refillPerSecond <= 0
  ) {
    throw new Error("token bucket capacity and refill rate must be positive finite numbers");
  }
  const buckets = new Map<string, { tokens: number; updatedAtMs: number }>();
  const maxKeys = options.maxKeys ?? 10_000;
  if (!Number.isSafeInteger(maxKeys) || maxKeys <= 0) {
    throw new Error("token bucket maxKeys must be a positive integer");
  }
  return {
    consume(key) {
      const nowMs = options.now();
      const existing = buckets.get(key);
      if (existing === undefined && buckets.size >= maxKeys) {
        const oldest = buckets.entries().next().value;
        if (oldest === undefined) return { outcome: "REJECTED", retryAfterMs: 1_000 };
        const [oldestKey, oldestBucket] = oldest;
        const oldestTokens = Math.min(
          options.capacity,
          oldestBucket.tokens +
            (Math.max(0, nowMs - oldestBucket.updatedAtMs) * options.refillPerSecond) / 1_000,
        );
        if (oldestTokens < options.capacity) {
          return { outcome: "REJECTED", retryAfterMs: 1_000 };
        }
        buckets.delete(oldestKey);
      }
      const elapsedMs = existing === undefined ? 0 : Math.max(0, nowMs - existing.updatedAtMs);
      const tokens = Math.min(
        options.capacity,
        (existing?.tokens ?? options.capacity) + (elapsedMs * options.refillPerSecond) / 1_000,
      );
      if (tokens < 1) {
        buckets.set(key, { tokens, updatedAtMs: nowMs });
        return {
          outcome: "REJECTED",
          retryAfterMs: Math.ceil(((1 - tokens) / options.refillPerSecond) * 1_000),
        };
      }
      buckets.delete(key);
      buckets.set(key, { tokens: tokens - 1, updatedAtMs: nowMs });
      return { outcome: "ALLOWED" };
    },
  };
}

export function clientIpKey(request: Request): string {
  const forwarded = request.headers.get("x-forwarded-for")?.split(",", 1)[0]?.trim();
  const address = request.headers.get("cf-connecting-ip")?.trim() || forwarded || "unknown";
  return hashRateLimitKey(`ip:${address}`);
}

export function hashRateLimitKey(value: string): string {
  return new Bun.CryptoHasher("sha256").update(value).digest("hex");
}
