#!/usr/bin/env node
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import {
  assertBackupIsolation,
  atomicWritePrivate,
  createBackupManifest,
  encryptBackup,
  verifyBackupPayload,
} from "./lib/backup-manifest.mjs";
import {
  parseWranglerBookmark,
  parseWranglerRows,
} from "./lib/wrangler-json.mjs";

const execFileAsync = promisify(execFile);

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
export function parseBackupArgs(argv) {
  /** @type {Record<string, string>} */
  const values = { upload: "false" };
  for (let index = 0; index < argv.length; index += 1) {
    const flag = argv[index];
    if (flag === "--upload") {
      values.upload = "true";
      continue;
    }
    const value = argv[index + 1];
    if (!flag?.startsWith("--") || !value || value.startsWith("--")) {
      throw new Error(
        `invalid or missing value near ${flag ?? "end of arguments"}`,
      );
    }
    values[flag.slice(2)] = value;
    index += 1;
  }
  for (const required of [
    "environment",
    "database",
    "database-id",
    "source-account-id",
    "content-bucket",
    "backup-account-id",
    "backup-bucket",
    "output-dir",
    "config",
    "key-id",
    "retention-days",
  ]) {
    if (!values[required]) throw new Error(`--${required} is required`);
  }
  if (!/^(preview|staging|production)$/.test(values.environment)) {
    throw new Error("--environment must be preview, staging, or production");
  }
  const retentionDays = Number(values["retention-days"]);
  if (
    !Number.isInteger(retentionDays) ||
    retentionDays < 30 ||
    retentionDays > 3650
  ) {
    throw new Error("--retention-days must be an integer from 30 through 3650");
  }
  if (values.environment === "production" && values.upload !== "true") {
    throw new Error(
      "production backup requires --upload to independent storage",
    );
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
 *   now?: () => Date
 * }} input
 */
export async function runBackup(input) {
  const environment = input.environment ?? process.env;
  const key = environment.OPEN_ARTIFACTS_BACKUP_KEY;
  if (!key) throw new Error("OPEN_ARTIFACTS_BACKUP_KEY is required");
  assertBackupIsolation({
    environment: input.args.environment,
    sourceAccountId: input.args["source-account-id"],
    destinationAccountId: input.args["backup-account-id"],
    contentBucket: input.args["content-bucket"],
    backupBucket: input.args["backup-bucket"],
  });
  const runner = input.runner ?? defaultRunner;
  const now = (input.now ?? (() => new Date()))();
  const timestamp = now.toISOString().replace(/[-:.]/g, "");
  const backupId = `backup-${timestamp}`;
  const objectPrefix = `${input.args.environment}/${now.getUTCFullYear()}/${String(
    now.getUTCMonth() + 1,
  ).padStart(2, "0")}`;
  const objectKey = `${objectPrefix}/${backupId}.sql.enc`;
  const outputDirectory = input.args["output-dir"];
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const payloadPath = join(outputDirectory, basename(objectKey));
  const manifestPath = join(outputDirectory, `${backupId}.manifest.json`);
  const temporaryDirectory = await mkdtemp(
    join(tmpdir(), "open-artifacts-backup-"),
  );
  const exportPath = join(temporaryDirectory, "database.sql");
  const sourceEnvironment = {
    ...environment,
    CLOUDFLARE_ACCOUNT_ID: input.args["source-account-id"],
  };
  const common = [
    input.args.database,
    "--remote",
    "--config",
    input.args.config,
  ];
  try {
    const bookmarkOutput = await runner(
      [
        "d1",
        "time-travel",
        "info",
        input.args.database,
        "--json",
        "--config",
        input.args.config,
      ],
      sourceEnvironment,
    );
    const bookmark = parseWranglerBookmark(bookmarkOutput.stdout);
    /** @param {string} sql */
    const query = async (sql) => {
      const output = await runner(
        ["d1", "execute", ...common, "--json", "--command", sql],
        sourceEnvironment,
      );
      return parseWranglerRows(output.stdout);
    };
    const schemaRows = await query(verificationSql.schema);
    const countRows = await query(verificationSql.rows);
    const sampleRows = await query(verificationSql.samples);
    await runner(
      [
        "d1",
        "export",
        input.args.database,
        "--remote",
        "--skip-confirmation",
        `--output=${exportPath}`,
        "--config",
        input.args.config,
      ],
      sourceEnvironment,
    );
    const plaintext = await readFile(exportPath);
    const encrypted = encryptBackup(plaintext, key, {
      keyId: input.args["key-id"],
    });
    const expiresAt = new Date(
      now.getTime() + Number(input.args["retention-days"]) * 86_400_000,
    ).toISOString();
    const manifest = createBackupManifest({
      backupId,
      source: {
        environment: input.args.environment,
        accountId: input.args["source-account-id"],
        databaseId: input.args["database-id"],
        databaseName: input.args.database,
      },
      destination: {
        accountId: input.args["backup-account-id"],
        bucket: input.args["backup-bucket"],
        objectKey,
      },
      createdAt: now.toISOString(),
      expiresAt,
      bookmark,
      plaintext,
      encrypted: encrypted.payload,
      encryption: encrypted.encryption,
      verification: {
        schemaVersion: Number(schemaRows[0]?.schema_version ?? -1),
        rowCounts: Object.fromEntries(
          countRows.map((row) => [
            String(row.table_name),
            Number(row.row_count),
          ]),
        ),
        samples: sampleRows.map((row) => ({
          artifactId: String(row.artifact_id),
          version: Number(row.version),
          contentHash: String(row.content_hash),
        })),
      },
    });
    await atomicWritePrivate(payloadPath, encrypted.payload);
    await atomicWritePrivate(
      manifestPath,
      `${JSON.stringify(manifest, null, 2)}\n`,
    );
    const upload = input.args.upload === "true";
    if (upload) {
      const uploadToken = environment.OPEN_ARTIFACTS_BACKUP_UPLOAD_TOKEN;
      if (!uploadToken) {
        throw new Error(
          "OPEN_ARTIFACTS_BACKUP_UPLOAD_TOKEN is required for upload",
        );
      }
      const destinationEnvironment = {
        ...environment,
        CLOUDFLARE_ACCOUNT_ID: input.args["backup-account-id"],
        CLOUDFLARE_API_TOKEN: uploadToken,
      };
      const destination = `${input.args["backup-bucket"]}/${objectKey}`;
      await runner(
        ["r2", "object", "put", destination, `--file=${payloadPath}`],
        destinationEnvironment,
      );
      await runner(
        [
          "r2",
          "object",
          "put",
          `${destination}.manifest.json`,
          `--file=${manifestPath}`,
          "--content-type=application/json",
        ],
        destinationEnvironment,
      );
      const verificationPath = join(temporaryDirectory, "uploaded.sql.enc");
      await runner(
        ["r2", "object", "get", destination, `--file=${verificationPath}`],
        destinationEnvironment,
      );
      verifyBackupPayload(await readFile(verificationPath), manifest);
    }
    return { backupId, payloadPath, manifestPath, uploaded: upload, manifest };
  } finally {
    await rm(temporaryDirectory, { recursive: true, force: true });
  }
}

const isMain =
  process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href;
if (isMain) {
  try {
    const report = await runBackup({
      args: parseBackupArgs(process.argv.slice(2)),
    });
    process.stdout.write(
      `${JSON.stringify({
        backupId: report.backupId,
        manifestPath: report.manifestPath,
        payloadPath: report.payloadPath,
        uploaded: report.uploaded,
      })}\n`,
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : "unknown failure";
    process.stderr.write(`backup-d1: ${message}\n`);
    process.exitCode = 1;
  }
}
