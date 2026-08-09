import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";
import { parseJsonc } from "../../scripts/lib/jsonc.mjs";

describe("production canary policy", () => {
  it("expands monotonically only after bounded observation windows", async () => {
    const policy = JSON.parse(
      await readFile("config/canary-policy.json", "utf8"),
    );
    expect(policy.phases.map((phase: { id: string }) => phase.id)).toEqual([
      "canary",
      "expanded",
      "general-team",
    ]);
    const traffic = policy.phases.map(
      (phase: { maximumTrafficPercent: number }) => phase.maximumTrafficPercent,
    );
    expect(traffic).toEqual([...traffic].sort((a, b) => a - b));
    for (const phase of policy.phases) {
      expect(phase.minimumObservationMinutes).toBeGreaterThanOrEqual(60);
      expect(policy.approval[phase.id].length).toBeGreaterThanOrEqual(2);
    }
  });

  it("aborts on the zero-tolerance integrity and authorization risks", async () => {
    const policy = JSON.parse(
      await readFile("config/canary-policy.json", "utf8"),
    );
    const alerts = JSON.parse(
      await readFile("config/observability/alerts.json", "utf8"),
    );
    const missingBlob = alerts.alerts.find(
      (alert: { id: string }) => alert.id === "missing-blob",
    );
    expect(policy.promotionGates.missingBlobCount).toBe(0);
    expect(policy.promotionGates.unexplainedHighCriticalRisks).toBe(0);
    expect(policy.promotionGates.coreFlowFailures).toBe(0);
    expect(missingBlob.threshold.value).toBe(0);
    expect(policy.automaticAbort.join(" ")).toMatch(/authorization/i);
    expect(policy.automaticAbort.join(" ")).toMatch(/telemetry silence/i);
  });

  it("maps every declared kill switch to an explicit production binding", async () => {
    const policy = JSON.parse(
      await readFile("config/canary-policy.json", "utf8"),
    );
    const production = parseJsonc(
      await readFile("wrangler.production.jsonc", "utf8"),
    ) as { vars: Record<string, string> };
    for (const flag of Object.values(policy.killSwitches) as string[]) {
      expect(production.vars[flag]).toBe("0");
    }
    expect(production.vars.PUBLIC_CREATE_MODE).toBe("disabled");
    expect(production.vars.ANONYMOUS_COMMENTS).toBe("disabled");
  });
});
