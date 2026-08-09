import { readFile } from "node:fs/promises";
import { describe, expect, it } from "vitest";

describe("release browser support matrix", () => {
  it("requires Chromium and bounds every temporary exception to 14 days", async () => {
    const matrix = JSON.parse(
      await readFile("config/browser-support.json", "utf8"),
    );
    const reviewedAt = new Date(`${matrix.reviewedAt}T00:00:00.000Z`).getTime();
    const chromium = matrix.browsers.find(
      (browser: { id: string }) => browser.id === "chromium",
    );
    expect(chromium).toMatchObject({
      releaseRequired: true,
      status: "supported",
    });
    for (const browser of matrix.browsers.filter(
      (entry: { status: string }) => entry.status === "temporary-exception",
    )) {
      const expiry = new Date(`${browser.expiresAt}T00:00:00.000Z`).getTime();
      expect(expiry - reviewedAt).toBeLessThanOrEqual(14 * 86_400_000);
      expect(expiry).toBeGreaterThan(reviewedAt);
      expect(browser.owner).toBeTruthy();
      expect(browser.reason.length).toBeGreaterThan(80);
      expect(browser.exitCriteria.length).toBeGreaterThan(50);
    }
  });

  it("keeps the required Chromium project in Playwright and CI", async () => {
    const playwright = await readFile("playwright.config.ts", "utf8");
    const ci = await readFile(".github/workflows/ci.yml", "utf8");
    expect(playwright).toContain('name: "chromium"');
    expect(ci).toContain("name: Chromium E2E");
    expect(ci).toContain("pnpm test:e2e");
  });
});
