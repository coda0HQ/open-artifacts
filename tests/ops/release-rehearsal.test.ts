import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  loadRehearsalPlan,
  runReleaseRehearsal,
} from "../../scripts/release-rehearsal.mjs";

describe("release rehearsal orchestrator", () => {
  it("covers every required recovery path with an explicit decision point", () => {
    const plan = loadRehearsalPlan(process.cwd());
    expect(plan.stages.map((stage) => stage.id)).toEqual([
      "migration",
      "application-rollback-rollforward",
      "d1-backup-restore",
      "r2-repair",
      "token-rotation",
    ]);
    for (const stage of plan.stages) {
      expect(stage.validation.length).toBeGreaterThan(20);
      expect(stage.decisionPoint.length).toBeGreaterThan(20);
      expect(stage.commands.length).toBeGreaterThan(0);
    }
  });

  it("records command duration and immutable commit without command output", async () => {
    const directory = await mkdtemp(join(tmpdir(), "oa-rehearsal-test-"));
    const receiptPath = join(directory, "receipt.json");
    const runner = vi.fn(async () => 0);
    let tick = 0;
    try {
      const receipt = await runReleaseRehearsal({
        root: process.cwd(),
        commit: "0123456789abcdef0123456789abcdef01234567",
        receiptPath,
        runner,
        now: () => new Date(1_786_000_000_000 + tick++ * 250),
      });
      expect(receipt.status).toBe("passed");
      expect(receipt.stages).toHaveLength(5);
      expect(receipt.stages[0]).toMatchObject({ status: "passed" });
      expect(receipt.stages[0]?.durationMs).toBeGreaterThan(0);
      expect(runner).toHaveBeenCalledTimes(8);
      const persisted = await readFile(receiptPath, "utf8");
      expect(persisted).not.toContain("stdout");
      expect(JSON.parse(persisted)).toEqual(receipt);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it("stops at the first failed command", async () => {
    let call = 0;
    await expect(
      runReleaseRehearsal({
        root: process.cwd(),
        commit: "0123456789abcdef0123456789abcdef01234567",
        runner: async () => (call++ === 1 ? 2 : 0),
      }),
    ).rejects.toThrow(/application-rollback-rollforward/);
  });
});
