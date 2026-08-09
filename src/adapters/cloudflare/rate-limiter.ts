import type {
  RateLimiter,
  RateLimitInput,
  RateLimitResult,
} from "../../ports/rate-limiter";

export interface WorkersRateLimitBinding {
  limit(input: { key: string }): Promise<{ success: boolean }>;
}

/** Cloudflare's binding is intentionally treated as a soft, per-location gate. */
export class CloudflareRateLimiter implements RateLimiter {
  constructor(private readonly binding: WorkersRateLimitBinding) {}

  async consume(input: RateLimitInput): Promise<RateLimitResult> {
    const result = await this.binding.limit({ key: input.key });
    return {
      allowed: result.success,
      retryAfterSeconds: Math.max(1, input.windowSeconds),
    };
  }
}
