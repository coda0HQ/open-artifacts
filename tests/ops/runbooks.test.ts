import { access, readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

const required = [
  "partial-publication",
  "missing-blob",
  "token-loss",
  "migrations",
  "restore",
  "abuse",
  "live",
  "telemetry",
  "upstream-rollback",
];

describe("operator runbook inventory", () => {
  it("covers every required incident with an owner and concrete validation", async () => {
    for (const name of required) {
      const path = `docs/runbooks/${name}.md`;
      await expect(access(path)).resolves.toBeUndefined();
      const content = await readFile(path, "utf8");
      expect(content).toMatch(/^# /);
      expect(content).toMatch(/Owner:/i);
      expect(content.length).toBeGreaterThan(500);
      expect(content).not.toMatch(/TODO|TBD/);
    }
  });

  it("documents the resumable repair and isolated restore commands", async () => {
    const partial = await readFile(
      "docs/runbooks/partial-publication.md",
      "utf8",
    );
    const restore = await readFile("docs/runbooks/restore.md", "utf8");
    expect(partial).toContain("--resume");
    expect(partial).toContain("repair-storage.mjs");
    expect(restore).toContain("restore-staging.mjs");
    expect(restore).toMatch(/refuses `production`/);
  });
});
