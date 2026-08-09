import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/ops/**/*.test.ts", "tests/load/**/*.test.ts"],
    pool: "forks",
    maxWorkers: 1,
  },
});
