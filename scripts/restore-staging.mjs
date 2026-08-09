#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  atomicWritePrivate,
  decryptBackup,
  validateBackupManifest,
} from "./lib/backup-manifest.mjs";
import { parseWranglerRows } from "./lib/wrangler-json.mjs";

export { parseWranglerRows } from "./lib/wrangler-json.mjs";

const execFileAsync = promisify(execFile);

/** @typedef {{artifactId: string, version: number, contentHash: string}} BackupSample */
/** @typedef {{schemaVersion: number, rowCounts: Record<string, number>, samples: BackupSample[]}} RestoreSnapshot */

/**
 * @param {{targetEnvironment: string, targetDatabaseId: string, sourceDatabaseId: string}} input
 */
export function assertRestoreTarget(input) {
  if (
    input.targetEnvironment === "production" ||
    !/^(staging|preview|restore-[a-z0-9-]+)$/.test(input.targetEnvironment)
  ) {
    throw new Error(
      "restore target must be an isolated staging/preview environment, never production",
    );
  }
  if (input.targetDatabaseId === input.sourceDatabaseId) {
    throw new Error("restore target must not be the source database");
  }
}

/** @param {RestoreSnapshot} expected @param {RestoreSnapshot} actual */
export function buildRestoreValidation(expected, actual) {
  /** @type {string[]} */
  const failures = [];
  if (actual.schemaVersion !== expected.schemaVersion) {
    failures.push(
      `schema version mismatch: expected ${expected.schemaVersion}, got ${actual.schemaVersion}`,
    );
  }
  for (const [table, count] of Object.entries(expected.rowCounts)) {
    if (actual.rowCounts[table] !== count) {
      failures.push(
        `row count mismatch for ${table}: expected ${count}, got ${String(actual.rowCounts[table])}`,
      );
    }
  }
  const actualSamples = new Map(
    actual.samples.map((sample) => [
      `${sample.artifactId}:${sample.version}`,
      sample.contentHash,
    ]),
  );
  for (const sample of expected.samples) {
    const key = `${sample.artifactId}:${sample.version}`;
    if (actualSamples.get(key) !== sample.contentHash) {
      failures.push(`hash mismatch for immutable version ${key}`);
    }
  }
  return { ok: failures.length === 0, failures };
}

/**
 * @param {{baseUrl: string, sample: BackupSample, fetchImpl?: typeof fetch}} input
 */
export async function validateRestoredArtifact(input) {
  const fetchImpl = input.fetchImpl ?? fetch;
  const baseUrl = input.baseUrl.replace(/\/+$/, "");
  const read = await fetchImpl(
    `${baseUrl}/a/${encodeURIComponent(input.sample.artifactId)}?v=${input.sample.version}`,
  );
  const unauthorizedWrite = await fetchImpl(
    `${baseUrl}/api/artifacts/${encodeURIComponent(input.sample.artifactId)}`,
    {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ title: "unauthorized restore probe" }),
    },
  );
  return {
    readable: read.ok,
    unauthorizedWriteBlocked: [401, 403, 404].includes(
      unauthorizedWrite.status,
    ),
  };
}

const verificationSql = {
  schema:
    "SELECT version AS schema_version FROM schema_meta WHERE singleton = 1",
  rows: [
    "SELECT 'artifacts' AS table_name, COUNT(*) AS row_count FROM artifacts",
    "SELECT 'versions' AS table_name, COUNT(*) AS row_count FROM versions",
    "SELECT 'comments' AS table_name, COUNT(*) AS row_count FROM comments",
    "SELECT 'handoffs' AS table_name, COUNT(*) AS row_count FROM handoffs",
    "SELECT 'publications' AS table_name, COUNT(*) AS row_count FROM publications",
  ].join(" UNION ALL "),
  samples:
    "SELECT artifact_id, version, content_hash FROM versions WHERE content_hash IS NOT NULL ORDER BY artifact_id, version LIMIT 20",
};

/** @param {string[]} argv */
export function parseRestoreArgs(argv) {
  /** @type {Record<string, string>} */
  const values = {};
  for (let index = 0; index < argv.length; index += 2) {
    const flag = argv[index];
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(
        `invalid or missing value near ${flag ?? "end of arguments"}`,
      );
    }
    values[flag.slice(2)] = value;
  }
  for (const required of [
    "manifest",
    "payload",
    "target-environment",
    "target-database",
    "target-database-id",
    "config",
    "base-url",
    "confirm",
    "audit-output",
  ]) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }
  if (values.confirm !== values["target-database-id"]) {
    throw new Error("--confirm must exactly match --target-database-id");
  }
  return values;
}

/** @param {string[]} args @param {NodeJS.ProcessEnv} environment */
async function defaultRunner(args, environment) {
  return execFileAsync("pnpm", ["exec", "wrangler", ...args], {
    env: environment,
    maxBuffer: 20 * 1024 * 1024,
  });
}

/**
 * @param {{
 *   args: Record<string, string>,
 *   environment?: NodeJS.ProcessEnv,
 *   runner?: (args: string[], environment: NodeJS.ProcessEnv) => Promise<{stdout: string, stderr?: string}>,
 *   fetchImpl?: typeof fetch,
 *   now?: () => Date
 * }} input
 */
export async function runRestore(input) {
  const environment = input.environment ?? process.env;
  const key = environment.OPEN_ARTIFACTS_BACKUP_KEY;
  if (!key) throw new Error("OPEN_ARTIFACTS_BACKUP_KEY is required");
  const manifest = JSON.parse(await readFile(input.args.manifest, "utf8"));
  validateBackupManifest(manifest);
  assertRestoreTarget({
    targetEnvironment: input.args["target-environment"],
    targetDatabaseId: input.args["target-database-id"],
    sourceDatabaseId: manifest.source.databaseId,
  });
  const payload = await readFile(input.args.payload);
  const plaintext = decryptBackup(payload, manifest, key);
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "open-artifacts-restore-"),
  );
  const sqlPath = join(temporaryDirectory, "restore.sql");
  const runner = input.runner ?? defaultRunner;
  const common = [
    input.args["target-database"],
    "--remote",
    "--config",
    input.args.config,
  ];
  const startedAt = (input.now ?? (() => new Date()))();
  try {
    await atomicWritePrivate(sqlPath, plaintext);
    await runner(
      ["d1", "execute", ...common, "--yes", "--file", sqlPath],
      environment,
    );
    /** @param {string} sql */
    const query = async (sql) => {
      const output = await runner(
        ["d1", "execute", ...common, "--json", "--command", sql],
        environment,
      );
      return parseWranglerRows(output.stdout);
    };
    const schemaRows = await query(verificationSql.schema);
    const countRows = await query(verificationSql.rows);
    const sampleRows = await query(verificationSql.samples);
    const actual = /** @type {RestoreSnapshot} */ ({
      schemaVersion: Number(schemaRows[0]?.schema_version ?? -1),
      rowCounts: Object.fromEntries(
        countRows.map((row) => [String(row.table_name), Number(row.row_count)]),
      ),
      samples: sampleRows.map((row) => ({
        artifactId: String(row.artifact_id),
        version: Number(row.version),
        contentHash: String(row.content_hash),
      })),
    });
    const databaseValidation = buildRestoreValidation(
      manifest.verification,
      actual,
    );
    const sample = manifest.verification.samples[0];
    const applicationValidation = sample
      ? await validateRestoredArtifact({
          baseUrl: input.args["base-url"],
          sample,
          fetchImpl: input.fetchImpl,
        })
      : { readable: true, unauthorizedWriteBlocked: true };
    const finishedAt = (input.now ?? (() => new Date()))();
    const report = {
      schemaVersion: 1,
      backupId: manifest.backupId,
      sourceDatabaseId: manifest.source.databaseId,
      targetDatabaseId: input.args["target-database-id"],
      targetEnvironment: input.args["target-environment"],
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      durationMs: Math.max(0, finishedAt.getTime() - startedAt.getTime()),
      databaseValidation,
      applicationValidation,
      ok:
        databaseValidation.ok &&
        applicationValidation.readable &&
        applicationValidation.unauthorizedWriteBlocked,
    };
    await atomicWritePrivate(
      input.args["audit-output"],
      `${JSON.stringify(report, null, 2)}\n`,
    );
    if (!report.ok) throw new Error("restored staging validation failed");
    return report;
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const report = await runRestore({
      args: parseRestoreArgs(process.argv.slice(2)),
    });
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`restore-staging: ${message}\n`);
    process.exitCode = 1;
  }
}
