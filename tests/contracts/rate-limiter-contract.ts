import { describe, expect, it } from "vitest";
import type { RateLimiter } from "../../src/ports/rate-limiter";

export function rateLimiterContract(
  name: string,
  createLimiter: () => Promise<RateLimiter> | RateLimiter,
): void {
  describe(`${name} RateLimiter contract`, () => {
    it("isolates keys and returns a bounded retry hint after saturation", async () => {
      const limiter = await createLimiter();
      const request = { key: `${name}:one`, limit: 2, windowSeconds: 30 };
      expect(await limiter.consume(request)).toMatchObject({ allowed: true });
      expect(await limiter.consume(request)).toMatchObject({ allowed: true });
      const rejected = await limiter.consume(request);
      expect(rejected.allowed).toBe(false);
      expect(rejected.retryAfterSeconds).toBeGreaterThanOrEqual(1);
      expect(
        await limiter.consume({ ...request, key: `${name}:two` }),
      ).toMatchObject({ allowed: true });
    });
  });
}
