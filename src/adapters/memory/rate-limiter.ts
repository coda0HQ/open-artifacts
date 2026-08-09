import type {
  RateLimiter,
  RateLimitInput,
  RateLimitResult,
} from "../../ports/rate-limiter";

interface WindowState {
  count: number;
  resetsAt: number;
}

export class MemoryRateLimiter implements RateLimiter {
  private readonly windows = new Map<string, WindowState>();

  constructor(private readonly now: () => number = Date.now) {}

  async consume(input: RateLimitInput): Promise<RateLimitResult> {
    const now = this.now();
    const duration = Math.max(1, input.windowSeconds) * 1_000;
    let state = this.windows.get(input.key);
    if (!state || state.resetsAt <= now) {
      state = { count: 0, resetsAt: now + duration };
      this.windows.set(input.key, state);
    }
    if (state.count >= Math.max(1, input.limit)) {
      return {
        allowed: false,
        retryAfterSeconds: Math.max(
          1,
          Math.ceil((state.resetsAt - now) / 1_000),
        ),
      };
    }
    state.count += 1;
    return {
      allowed: true,
      retryAfterSeconds: Math.max(1, Math.ceil((state.resetsAt - now) / 1_000)),
    };
  }
}
