#!/usr/bin/env node
import { spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parseJsonc } from "./lib/jsonc.mjs";

const ENVIRONMENTS = ["preview", "staging", "production"];

/** @param {Record<string, unknown>} config */
function bindingNames(config) {
  const names = [];
  const assets = /** @type {{binding?: string}} */ (config.assets ?? {});
  if (assets.binding) names.push(assets.binding);
  for (const [collection, key] of [
    ["d1_databases", "binding"],
    ["r2_buckets", "binding"],
    ["analytics_engine_datasets", "binding"],
    ["ratelimits", "name"],
  ]) {
    for (const entry of /** @type {Record<string, unknown>[]} */ (
      config[collection] ?? []
    )) {
      if (typeof entry[key] === "string") names.push(String(entry[key]));
    }
  }
  const durable = /** @type {{bindings?: Array<{name?: string}>}} */ (
    config.durable_objects ?? {}
  );
  for (const binding of durable.bindings ?? []) {
    if (binding.name) names.push(binding.name);
  }
  return names;
}

/** @param {Record<string, unknown>} config */
function resourceIdentity(config) {
  const d1 =
    /** @type {Array<Record<string, unknown>>} */ (
      config.d1_databases ?? []
    )[0] ?? {};
  const r2 =
    /** @type {Array<Record<string, unknown>>} */ (
      config.r2_buckets ?? []
    )[0] ?? {};
  const metrics =
    /** @type {Array<Record<string, unknown>>} */ (
      config.analytics_engine_datasets ?? []
    )[0] ?? {};
  const rate =
    /** @type {Array<Record<string, unknown>>} */ (
      config.ratelimits ?? []
    )[0] ?? {};
  const workerName = String(config.name ?? "");
  const routes = /** @type {unknown[]} */ (config.routes ?? []);
  return {
    workerName,
    domainIdentity:
      routes.length > 0
        ? JSON.stringify(routes)
        : `${workerName}.${config.workers_dev === true ? "workers.dev" : "disabled"}`,
    databaseId: String(d1.database_id ?? ""),
    databaseName: String(d1.database_name ?? ""),
    contentBucket: String(r2.bucket_name ?? ""),
    metricsDataset: String(metrics.dataset ?? ""),
    rateLimitNamespace: String(rate.namespace_id ?? ""),
  };
}

/** @param {string} root */
export function loadEnvironmentConfigs(root) {
  return ENVIRONMENTS.map((environment) => {
    const file = `wrangler.${environment}.jsonc`;
    const config = /** @type {Record<string, unknown>} */ (
      parseJsonc(readFileSync(join(root, file), "utf8"))
    );
    return {
      environment,
      file,
      config,
      resources: resourceIdentity(config),
    };
  });
}

/** @param {string} root */
export function checkEnvironmentConfigs(root) {
  const policy = /** @type {Record<string, unknown>} */ (
    JSON.parse(
      readFileSync(join(root, "config/environment-policy.json"), "utf8"),
    )
  );
  const requiredBindings = /** @type {string[]} */ (policy.requiredBindings);
  const forbiddenInlineSecrets = /** @type {string[]} */ (
    policy.forbiddenInlineSecrets
  );
  const requiredKillSwitches = /** @type {string[]} */ (
    policy.requiredKillSwitches
  );
  const distinctResources = /** @type {string[]} */ (policy.distinctResources);
  const loaded = loadEnvironmentConfigs(root);
  const issues = [];
  const reports = [];

  for (const entry of loaded) {
    const { config, environment, file } = entry;
    const variables = /** @type {Record<string, unknown>} */ (
      config.vars ?? {}
    );
    const bindings = bindingNames(config);
    const d1 =
      /** @type {Array<Record<string, unknown>>} */ (
        config.d1_databases ?? []
      )[0] ?? {};
    const exportsMap = /** @type {Record<string, Record<string, unknown>>} */ (
      config.exports ?? {}
    );
    for (const binding of requiredBindings) {
      if (!bindings.includes(binding))
        issues.push(`${file}: missing ${binding} binding`);
    }
    if (variables.ENVIRONMENT !== environment) {
      issues.push(`${file}: ENVIRONMENT must equal ${environment}`);
    }
    if (variables.TELEMETRY_ENV !== environment) {
      issues.push(`${file}: TELEMETRY_ENV must equal ${environment}`);
    }
    if (variables.PUBLIC_CREATE_MODE === "open") {
      issues.push(`${file}: remote public create cannot be open`);
    }
    if (variables.ANONYMOUS_COMMENTS !== "disabled") {
      issues.push(`${file}: anonymous comments must default to disabled`);
    }
    if (variables.RATE_LIMIT_MODE !== "cloudflare") {
      issues.push(
        `${file}: remote rate limiting must use the Cloudflare binding`,
      );
    }
    for (const name of forbiddenInlineSecrets) {
      if (Object.hasOwn(variables, name))
        issues.push(`${file}: ${name} must be a Secret`);
    }
    const killSwitches = {};
    for (const name of requiredKillSwitches) {
      const value = variables[name];
      if (value !== "0" && value !== "1") {
        issues.push(`${file}: ${name} must be explicitly set to 0 or 1`);
      }
      killSwitches[name] = value;
    }
    if (d1.migrations_dir !== "migrations") {
      issues.push(`${file}: DB must use the numbered migrations directory`);
    }
    if ("migrations" in config) {
      issues.push(`${file}: legacy Durable Object migrations are forbidden`);
    }
    if (
      exportsMap.LiveObject?.type !== "durable-object" ||
      exportsMap.LiveObject?.storage !== "sqlite"
    ) {
      issues.push(`${file}: LiveObject declarative sqlite export is required`);
    }
    if (!/^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(entry.resources.databaseId)) {
      issues.push(`${file}: database_id must be a UUID`);
    }
    if (Object.values(entry.resources).some((value) => value.length === 0)) {
      issues.push(`${file}: all resource identities must be non-empty`);
    }
    reports.push({
      environment,
      file,
      resources: entry.resources,
      requiredBindings: bindings,
      migrationsDir: String(d1.migrations_dir ?? ""),
      killSwitches,
    });
  }

  for (const key of distinctResources) {
    const values = loaded.map(
      (entry) =>
        entry.resources[/** @type {keyof typeof entry.resources} */ (key)],
    );
    if (new Set(values).size !== loaded.length) {
      issues.push(
        `${key} must be distinct across preview, staging, and production`,
      );
    }
  }
  return {
    schemaVersion: Number(policy.schemaVersion),
    issues,
    environments: reports,
  };
}

/** @param {string} root */
export function verifyWranglerDryRuns(root) {
  const outputRoot = mkdtempSync(join(tmpdir(), "open-artifacts-env-check-"));
  try {
    for (const environment of ENVIRONMENTS) {
      const result = spawnSync(
        join(
          root,
          "node_modules",
          ".bin",
          process.platform === "win32" ? "wrangler.cmd" : "wrangler",
        ),
        [
          "deploy",
          "--dry-run",
          "--outdir",
          join(outputRoot, environment),
          "-c",
          `wrangler.${environment}.jsonc`,
        ],
        { cwd: root, env: { ...process.env, CI: "1" }, encoding: "utf8" },
      );
      if (result.status !== 0) {
        throw new Error(
          `wrangler ${environment} dry-run failed:\n${result.stderr}\n${result.stdout}`,
        );
      }
    }
  } finally {
    rmSync(outputRoot, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const root = process.cwd();
    const report = checkEnvironmentConfigs(root);
    if (report.issues.length > 0) {
      throw new Error(report.issues.join("\n"));
    }
    verifyWranglerDryRuns(root);
    process.stdout.write(
      `Environment isolation: ${report.environments.length} configs and Wrangler dry-runs passed.\n`,
    );
  } catch (error) {
    process.stderr.write(
      `${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
