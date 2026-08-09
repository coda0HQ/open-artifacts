import {
  createExecutionContext,
  waitOnExecutionContext,
} from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { MemoryRateLimiter } from "../../src/adapters/memory/rate-limiter";
import type { AppContext } from "../../src/api";
import { createApp } from "../../src/app";
import { actorKeyForRequest } from "../../src/rate-limit";

describe("MemoryRateLimiter", () => {
  it("allows only the configured number of events in a fixed window", async () => {
    let now = 1_000;
    const limiter = new MemoryRateLimiter(() => now);
    const input = { key: "actor:route:resource", limit: 2, windowSeconds: 60 };

    expect((await limiter.consume(input)).allowed).toBe(true);
    expect((await limiter.consume(input)).allowed).toBe(true);
    const denied = await limiter.consume(input);
    expect(denied.allowed).toBe(false);
    expect(denied.retryAfterSeconds).toBe(60);

    now += 60_000;
    expect((await limiter.consume(input)).allowed).toBe(true);
  });
});

describe("rate limit middleware", () => {
  it("uses a pseudonymous key and returns a stable rejection contract", async () => {
    const keys: string[] = [];
    const binding = {
      async limit(input: { key: string }) {
        keys.push(input.key);
        return { success: keys.length === 1 };
      },
    };
    const testEnv: AppContext["Bindings"] = {
      ...env,
      ENVIRONMENT: "test",
      RATE_LIMIT_MODE: "cloudflare",
      RATE_LIMITER: binding,
    };
    const app = createApp();
    const request = () =>
      new Request("http://artifacts.test/api/artifacts", {
        method: "POST",
        headers: {
          authorization: "Bearer raw-secret-must-not-enter-key",
          "content-type": "application/json",
        },
        body: JSON.stringify({
          content: "<p>x</p>",
          title: "Rate limit",
          favicon: "📊",
        }),
      });

    const firstContext = createExecutionContext();
    const first = await app.fetch(request(), testEnv, firstContext);
    await waitOnExecutionContext(firstContext);
    expect(first.status).toBe(201);

    const secondContext = createExecutionContext();
    const second = await app.fetch(request(), testEnv, secondContext);
    await waitOnExecutionContext(secondContext);
    expect(second.status).toBe(429);
    expect(second.headers.get("retry-after")).toBe("60");
    expect(await second.json()).toEqual({
      error: "rate limit exceeded",
      code: "RATE_LIMITED",
    });
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(keys[0]).not.toContain("raw-secret-must-not-enter-key");
  });

  it("derives the same actor key without exposing bearer or address material", async () => {
    const request = new Request("http://artifacts.test/api/artifacts/a1/live", {
      headers: {
        authorization: "Bearer sensitive-token",
        "cf-connecting-ip": "203.0.113.7",
      },
    });
    const first = await actorKeyForRequest(request);
    const second = await actorKeyForRequest(request);
    expect(first).toBe(second);
    expect(first).not.toContain("sensitive-token");
    expect(first).not.toContain("203.0.113.7");
  });
});
