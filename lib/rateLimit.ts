export class RateLimitError extends Error {
  constructor(message = "Too many requests -- please slow down.") {
    super(message);
    this.name = "RateLimitError";
  }
}

const buckets = new Map<string, number[]>();

/**
 * Basic in-memory sliding-window rate limiter (single-instance self-hosted
 * deployment per technical-spec.md; no shared store needed).
 */
export function checkRateLimit(key: string, opts: { max: number; windowMs: number }) {
  const now = Date.now();
  const timestamps = (buckets.get(key) ?? []).filter((t) => now - t < opts.windowMs);

  if (timestamps.length >= opts.max) {
    throw new RateLimitError();
  }

  timestamps.push(now);
  buckets.set(key, timestamps);
}
