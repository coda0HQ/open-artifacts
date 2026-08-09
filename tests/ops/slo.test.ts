import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("SLO operating policy", () => {
  it("defines measurable availability, integrity, publication and recovery objectives", async () => {
    const content = await readFile("docs/ops/slo.md", "utf8");
    for (const required of [
      "99.9%",
      "99.5%",
      "Content integrity",
      "RPO ≤24 h",
      "RTO ≤4 h",
      "Error-budget policy",
      "acknowledge within 15 minutes",
      "Missing Blob",
    ]) {
      expect(content).toContain(required);
    }
    expect(content).toMatch(/telemetry is an outage/i);
    expect(content).toMatch(/conflicts.*excluded/i);
  });
});
