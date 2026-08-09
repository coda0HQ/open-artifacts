import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      // Bind LIVE_DO in the pool so the bound-path live tests can run. The
      // no-binding contract stays covered: live.test.ts passes an explicit
      // { ...env, LIVE_DO: undefined } env for the 404 suite. Mirrors
      // wrangler.dev.jsonc's durable_objects + exports (SQLite DO).
      miniflare: {
        bindings: {
          ENVIRONMENT: "test",
          PUBLIC_CREATE_MODE: "open",
          ANONYMOUS_COMMENTS: "enabled",
          RATE_LIMIT_MODE: "local",
          IDEMPOTENCY_SECRET: "test-only-idempotency-secret",
        },
        durableObjects: {
          LIVE_DO: { className: "LiveObject", useSQLite: true },
        },
      },
    }),
  ],
  test: {
    include: [
      "tests/worker/**/*.test.ts",
      "tests/integration/**/*.test.ts",
      "tests/failure-injection/**/*.test.ts",
      "tests/concurrency/**/*.test.ts",
      "tests/security/**/*.test.ts",
    ],
    // The embedded OG-card fonts (Inter + a Noto Sans SC subset) make the
    // worker bundle a few MB, so workerd's first-request cold-start compile can
    // exceed vitest's 5s default under load. Give each isolate room to warm up.
    testTimeout: 20000,
  },
});
