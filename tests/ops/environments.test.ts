import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  checkEnvironmentConfigs,
  loadEnvironmentConfigs,
} from "../../scripts/check-environments.mjs";
import { parseJsonc } from "../../scripts/lib/jsonc.mjs";

const root = process.cwd();

describe("isolated deployment environments", () => {
  it("parses comments and trailing commas without changing string content", () => {
    expect(
      parseJsonc('{"url":"https://example.test/a//b",/* note */"x":1,}'),
    ).toEqual({ url: "https://example.test/a//b", x: 1 });
  });

  it("gives preview, staging, and production distinct stateful resources", () => {
    const environments = loadEnvironmentConfigs(root);
    expect(environments.map((entry) => entry.environment)).toEqual([
      "preview",
      "staging",
      "production",
    ]);

    for (const key of [
      "workerName",
      "domainIdentity",
      "databaseId",
      "databaseName",
      "contentBucket",
      "metricsDataset",
      "rateLimitNamespace",
    ] as const) {
      expect(
        new Set(environments.map((entry) => entry.resources[key])).size,
      ).toBe(environments.length);
    }
  });

  it("pins production-shaped bindings, migration directories, and safe flags", () => {
    const report = checkEnvironmentConfigs(root);
    expect(report.issues).toEqual([]);
    expect(report.schemaVersion).toBe(1);
    expect(report.environments).toHaveLength(3);
    for (const environment of report.environments) {
      expect(environment.requiredBindings).toEqual(
        expect.arrayContaining([
          "ASSETS",
          "DB",
          "CONTENT",
          "METRICS",
          "RATE_LIMITER",
          "LIVE_DO",
        ]),
      );
      expect(environment.migrationsDir).toBe("migrations");
      expect(environment.killSwitches).toEqual({
        KILL_SWITCH_WRITES: "0",
        KILL_SWITCH_LIVE: "0",
        KILL_SWITCH_COMMENTS: "0",
      });
    }
  });

  it("keeps runtime and deployment secrets out of committed vars", () => {
    const policy = JSON.parse(
      readFileSync(join(root, "config/environment-policy.json"), "utf8"),
    ) as { forbiddenInlineSecrets: string[] };
    for (const { config } of loadEnvironmentConfigs(root)) {
      const variables = config.vars as Record<string, unknown>;
      for (const name of policy.forbiddenInlineSecrets) {
        expect(variables).not.toHaveProperty(name);
      }
    }
  });
});
