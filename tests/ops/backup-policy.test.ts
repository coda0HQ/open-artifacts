import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("scheduled backup policy", () => {
  it("uses daily encrypted cross-account backups with bounded deletion", async () => {
    const policy = JSON.parse(
      await readFile("config/backup-policy.json", "utf8"),
    );
    expect(policy).toMatchObject({
      schemaVersion: 1,
      scheduleHours: 24,
      encryption: { algorithm: "aes-256-gcm", keySource: "secret-manager" },
      destination: { separateAccountRequired: true, immutableObjects: true },
      retention: { longTermDays: 90, deleteExpired: true },
      recovery: { target: "isolated-staging-only" },
    });
    expect(policy.retention.longTermDays).toBeGreaterThanOrEqual(30);
    expect(policy.retention.longTermDays).toBeLessThanOrEqual(3650);
  });

  it("keeps backup credentials in environment secrets and records only receipts", async () => {
    const workflow = await readFile(".github/workflows/backup.yml", "utf8");
    expect(workflow).toContain('cron: "23 2 * * *"');
    expect(workflow).toContain("OPEN_ARTIFACTS_BACKUP_KEY: ${{ secrets.");
    expect(workflow).toContain(
      "OPEN_ARTIFACTS_BACKUP_UPLOAD_TOKEN: ${{ secrets.",
    );
    expect(workflow).toContain("--upload");
    expect(workflow).toContain("manifest.json");
    expect(workflow).not.toMatch(/upload-artifact[\s\S]{0,500}\.sql\.enc/);
  });
});
