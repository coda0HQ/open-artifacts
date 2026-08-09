import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

interface AlertDefinition {
  id: string;
  metric: string;
  owner: string;
  severity: "P0" | "P1" | "P2";
  threshold: {
    comparator: "gt" | "gte" | "lt" | "lte" | "absent";
    value: number;
    windowMinutes: number;
    occurrences: number;
  };
  rationale: string;
  runbook: string;
  notification: string[];
}

interface AlertCatalog {
  schemaVersion: number;
  evaluationIntervalSeconds: number;
  alerts: AlertDefinition[];
}

const requiredAlerts = new Set([
  "missing-blob",
  "publication-failure-rate",
  "repeated-auth-failure",
  "migration-incompatible",
  "quota-exhaustion",
  "rate-saturation",
  "live-failure-rate",
  "telemetry-silence",
]);

async function catalog(): Promise<AlertCatalog> {
  return JSON.parse(
    await readFile("config/observability/alerts.json", "utf8"),
  ) as AlertCatalog;
}

describe("production alert catalog", () => {
  it("covers every P0 operational risk with bounded executable thresholds", async () => {
    const value = await catalog();
    expect(value.schemaVersion).toBe(1);
    expect(value.evaluationIntervalSeconds).toBeGreaterThanOrEqual(30);
    expect(value.evaluationIntervalSeconds).toBeLessThanOrEqual(300);

    const ids = value.alerts.map((alert) => alert.id);
    expect(new Set(ids)).toEqual(requiredAlerts);
    expect(ids).toHaveLength(new Set(ids).size);
    for (const alert of value.alerts) {
      expect(alert.metric).toMatch(/^[a-z_]+$/);
      expect(alert.owner).toMatch(/^[a-z-]+$/);
      expect(["P0", "P1", "P2"]).toContain(alert.severity);
      expect(alert.threshold.windowMinutes).toBeGreaterThan(0);
      expect(alert.threshold.occurrences).toBeGreaterThan(0);
      expect(Number.isFinite(alert.threshold.value)).toBe(true);
      expect(alert.rationale.length).toBeGreaterThan(24);
      expect(alert.runbook).toMatch(/^docs\/runbooks\/[a-z0-9-]+\.md$/);
      expect(alert.notification.length).toBeGreaterThan(0);
      await expect(readFile(alert.runbook, "utf8")).resolves.toContain("# ");
    }
  });

  it("contains no credentials or high-cardinality dimensions", async () => {
    const serialized = JSON.stringify(await catalog());
    expect(serialized).not.toMatch(/Bearer\s|api[_-]?key|account[_-]?id/i);
    expect(serialized).not.toMatch(
      /artifact[_-]?id|actor[_-]?id|request[_-]?id/i,
    );
  });
});
