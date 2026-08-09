import { CloudflareRateLimiter } from "../../../src/adapters/cloudflare/rate-limiter";
import { MemoryRateLimiter } from "../../../src/adapters/memory/rate-limiter";
import { rateLimiterContract } from "../../contracts/rate-limiter-contract";

rateLimiterContract("memory", () => new MemoryRateLimiter(() => 1_000));

rateLimiterContract("cloudflare", () => {
  const counts = new Map<string, number>();
  return new CloudflareRateLimiter({
    async limit({ key }) {
      const next = (counts.get(key) ?? 0) + 1;
      counts.set(key, next);
      return { success: next <= 2 };
    },
  });
});
