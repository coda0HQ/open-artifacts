export interface RateLimitInput {
  key: string;
  limit: number;
  windowSeconds: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSeconds: number;
}

/**
 * Low-latency flood protection. Implementations may be eventually consistent;
 * exact accounting belongs to QuotaLedger, never this port.
 */
export interface RateLimiter {
  consume(input: RateLimitInput): Promise<RateLimitResult>;
}
