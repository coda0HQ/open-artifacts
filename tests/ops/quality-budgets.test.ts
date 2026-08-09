import { performance } from "node:perf_hooks";
import { describe, expect, it } from "vitest";
import budget from "../../config/quality-budgets.json" with { type: "json" };
import { MemoryBlobStore } from "../../src/adapters/memory/blob-store.js";
import { MemoryMetadataStore } from "../../src/adapters/memory/metadata-store.js";
import { MemoryRateLimiter } from "../../src/adapters/memory/rate-limiter.js";
import { SystemClock } from "../../src/ports/clock.js";

function percentile(values: number[], fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return (
    sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))] ??
    0
  );
}

describe("local performance budgets", () => {
  it("keeps dependency composition well below the cold-start guardrail", () => {
    const startedAt = performance.now();
    for (let index = 0; index < 1_000; index += 1) {
      new MemoryBlobStore();
      new MemoryMetadataStore();
      new MemoryRateLimiter();
      new SystemClock();
    }
    expect(performance.now() - startedAt).toBeLessThan(
      budget.localPerformance.compositionStartupMs,
    );
  });

  it("bounds in-memory write/read p95 and heap growth", async () => {
    const store = new MemoryBlobStore();
    const payload = "x".repeat(4 * 1024);
    const before = process.memoryUsage().heapUsed;
    const writes: number[] = [];
    const reads: number[] = [];
    for (let index = 0; index < 250; index += 1) {
      const key = `budget/${index}`;
      let startedAt = performance.now();
      await store.putImmutable(key, payload, {
        contentHash: `sha256-${index}`,
        encrypted: false,
        publicationId: `publication-${index}`,
      });
      writes.push(performance.now() - startedAt);
      startedAt = performance.now();
      expect(await store.get(key)).not.toBeNull();
      reads.push(performance.now() - startedAt);
    }
    const growth = Math.max(0, process.memoryUsage().heapUsed - before);
    expect(percentile(writes, 0.95)).toBeLessThan(
      budget.localPerformance.memoryBlobWriteP95Ms,
    );
    expect(percentile(reads, 0.95)).toBeLessThan(
      budget.localPerformance.memoryBlobReadP95Ms,
    );
    expect(growth).toBeLessThan(budget.localPerformance.heapGrowthBytes);
  });
});
