import { describe, expect, it, vi } from "vitest";
import { assertLoadGate, runLoadPlan } from "../../scripts/lib/load-runner.mjs";

describe("bounded staging load runner", () => {
  it("exercises publish/read/comment/live with bounded concurrency and controlled 4xx", async () => {
    let active = 0;
    let maximumActive = 0;
    const fetchImpl = vi.fn(
      async (input: string | URL | Request, _init?: RequestInit) => {
        const request = input instanceof Request ? input : new Request(input);
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await Promise.resolve();
        active -= 1;
        return new Response(null, {
          status: request.url.includes("/comments") ? 429 : 200,
        });
      },
    );
    const report = await runLoadPlan({
      baseUrl: "https://staging.example.test",
      artifactId: "load-artifact",
      iterations: 5,
      concurrency: 3,
      fetchImpl,
      now: (() => {
        let time = 0;
        return () => (time += 2);
      })(),
    });

    expect(fetchImpl).toHaveBeenCalledTimes(20);
    expect(maximumActive).toBeLessThanOrEqual(3);
    expect(Object.keys(report.operations).sort()).toEqual([
      "comment",
      "live",
      "publish",
      "read",
    ]);
    expect(report.summary).toMatchObject({
      requests: 20,
      serverErrors: 0,
      controlledRejections: 5,
    });
    expect(() => assertLoadGate(report)).not.toThrow();
    expect(JSON.stringify(report)).not.toMatch(/authorization|Bearer|token/i);
  });

  it("fails the capacity gate on server errors rather than masking them as quota behavior", async () => {
    const report = await runLoadPlan({
      baseUrl: "https://staging.example.test",
      artifactId: "load-artifact",
      iterations: 1,
      concurrency: 1,
      fetchImpl: async () => new Response(null, { status: 503 }),
    });
    expect(report.summary.serverErrors).toBe(4);
    expect(() => assertLoadGate(report)).toThrow(/server errors/i);
  });
});
