import { defineConfig, devices } from "@playwright/test";

const port = 8788;
const baseURL = `http://127.0.0.1:${port}`;
const useSystemChrome =
  process.env.PLAYWRIGHT_USE_SYSTEM_CHROME === "1" ||
  (!process.env.CI && process.platform === "darwin");

export default defineConfig({
  testDir: "./tests",
  testMatch: ["e2e/**/*.spec.ts", "accessibility/**/*.spec.ts"],
  outputDir: "test-results",
  fullyParallel: false,
  workers: 1,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: [
    ["line"],
    ["html", { open: "never", outputFolder: "playwright-report" }],
  ],
  use: {
    baseURL,
    trace: "on-first-retry",
    screenshot: "only-on-failure",
    video: "retain-on-failure",
  },
  projects: [
    {
      name: "chromium",
      use: {
        ...devices["Desktop Chrome"],
        channel: useSystemChrome ? "chrome" : undefined,
      },
    },
  ],
  webServer: {
    command: `pnpm exec wrangler dev -c wrangler.dev.jsonc --port ${port} --persist-to .wrangler/e2e`,
    url: baseURL,
    timeout: 120_000,
    reuseExistingServer: !process.env.CI,
    stdout: "pipe",
    stderr: "pipe",
  },
});
