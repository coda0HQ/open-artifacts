import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("protected release workflows", () => {
  it("migrates before deploying and requires a progressive evidence receipt", async () => {
    const workflow = await readFile(".github/workflows/deploy.yml", "utf8");
    expect(workflow).toContain("Full commit SHA");
    expect(workflow).toContain("evidence_sha256");
    expect(workflow).toContain("canary|expanded|general-team");
    expect(workflow.indexOf("d1 migrations apply")).toBeGreaterThan(0);
    expect(workflow.indexOf("d1 migrations apply")).toBeLessThan(
      workflow.indexOf("Deploy the verified commit"),
    );
    expect(workflow).toContain(`environment: $${"{{ inputs.environment }}"}`);
  });

  it("builds release metadata from a clean full commit and cannot replace a tag", async () => {
    const workflow = await readFile(".github/workflows/release.yml", "utf8");
    for (const artifact of [
      "release-manifest.json",
      "sbom.cdx.json",
      "provenance.json",
      "SHA256SUMS",
    ]) {
      expect(workflow).toContain(artifact);
    }
    expect(workflow).toContain("--require-clean");
    expect(workflow).toContain("sha256sum --check");
    expect(workflow).toContain("environment: release-approval");
    expect(workflow).toContain("Refuse to replace an existing immutable tag");
  });

  it("pins every third-party Action to a full commit SHA", async () => {
    for (const file of [
      ".github/workflows/ci.yml",
      ".github/workflows/deploy.yml",
      ".github/workflows/release.yml",
      ".github/workflows/backup.yml",
      ".github/workflows/reconcile-staging.yml",
    ]) {
      const workflow = await readFile(file, "utf8");
      for (const line of workflow
        .split("\n")
        .filter((entry) => /uses:/.test(entry))) {
        expect(line).toMatch(/uses:\s+[^@\s]+@[0-9a-f]{40}(?:\s+#.*)?$/i);
      }
    }
  });
});
