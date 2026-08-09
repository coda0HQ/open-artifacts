import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("capacity and cost policy", () => {
  it("defines bounded staging traffic and a cost-model input for every write surface", async () => {
    const profile = JSON.parse(
      await readFile("config/load-profile.json", "utf8"),
    );
    expect(profile.schemaVersion).toBe(1);
    expect(profile.environment).toBe("staging");
    expect(profile.concurrency).toBeGreaterThan(0);
    expect(profile.concurrency).toBeLessThanOrEqual(20);
    expect(profile.operations).toEqual({
      publish: expect.any(Number),
      read: expect.any(Number),
      comment: expect.any(Number),
      live: expect.any(Number),
    });
    expect(profile.gates.serverErrors).toBe(0);
    expect(profile.gates.controlledStatuses).toEqual(
      expect.arrayContaining([401, 403, 409, 413, 429]),
    );
    expect(profile.costModel).toMatchObject({
      workerRequestsPerIteration: 4,
      d1Writes: expect.any(Object),
      r2Writes: expect.any(Object),
      durableObjectRequests: expect.any(Object),
    });
  });
});
