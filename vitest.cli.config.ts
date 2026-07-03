import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    include: ["tests/cli/**/*.test.ts"],
    environment: "node",
    testTimeout: 30000,
  },
});
