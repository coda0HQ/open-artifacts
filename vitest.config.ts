import { cloudflareTest } from "@cloudflare/vitest-pool-workers";
import { defineConfig } from "vitest/config";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: {
    include: ["tests/worker/**/*.test.ts"],
    // The embedded OG-card fonts (Inter + a Noto Sans SC subset) make the
    // worker bundle a few MB, so workerd's first-request cold-start compile can
    // exceed vitest's 5s default under load. Give each isolate room to warm up.
    testTimeout: 20000,
  },
});
