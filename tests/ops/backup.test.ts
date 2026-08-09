import { randomBytes } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parseBackupArgs, runBackup } from "../../scripts/backup-d1.mjs";
import {
  assertBackupIsolation,
  createBackupManifest,
  decryptBackup,
  encryptBackup,
  verifyBackupPayload,
} from "../../scripts/lib/backup-manifest.mjs";

const key = randomBytes(32).toString("base64");

describe("D1 backup envelope", () => {
  it("round-trips an authenticated encrypted export without persisting its key", () => {
    const plaintext = Buffer.from(
      "CREATE TABLE artifacts(id TEXT PRIMARY KEY);\n",
    );
    const encrypted = encryptBackup(plaintext, key, {
      iv: Buffer.alloc(12, 7),
      keyId: "backup-key-2026-q3",
    });
    const manifest = createBackupManifest({
      backupId: "backup-20260804T120000Z",
      source: {
        environment: "production",
        accountId: "source-account",
        databaseId: "source-db",
        databaseName: "open-artifacts-production",
      },
      destination: {
        accountId: "backup-account",
        bucket: "open-artifacts-backups",
        objectKey: "production/2026/08/backup.sql.enc",
      },
      createdAt: "2026-08-04T12:00:00.000Z",
      expiresAt: "2026-11-02T12:00:00.000Z",
      bookmark: "00000085-0000024c",
      plaintext,
      encrypted: encrypted.payload,
      encryption: encrypted.encryption,
      verification: {
        schemaVersion: 5,
        rowCounts: { artifacts: 3, versions: 7 },
        samples: [{ artifactId: "a-1", version: 1, contentHash: "abc" }],
      },
    });

    expect(verifyBackupPayload(encrypted.payload, manifest)).toBe(true);
    expect(decryptBackup(encrypted.payload, manifest, key)).toEqual(plaintext);
    expect(JSON.stringify(manifest)).not.toContain(key);
    expect(manifest.encryption.keyId).toBe("backup-key-2026-q3");
    expect(manifest.checksums.plaintextSha256).toMatch(/^[a-f0-9]{64}$/);
  });

  it("rejects ciphertext or manifest tampering before restore", () => {
    const plaintext = Buffer.from("SELECT 1;\n");
    const encrypted = encryptBackup(plaintext, key, {
      iv: Buffer.alloc(12, 9),
      keyId: "backup-key",
    });
    const manifest = createBackupManifest({
      backupId: "backup-tamper-test",
      source: {
        environment: "staging",
        accountId: "source-account",
        databaseId: "source-db",
        databaseName: "staging-db",
      },
      destination: {
        accountId: "backup-account",
        bucket: "backup-bucket",
        objectKey: "staging/tamper.sql.enc",
      },
      createdAt: "2026-08-04T12:00:00.000Z",
      expiresAt: "2026-11-02T12:00:00.000Z",
      bookmark: "bookmark-1",
      plaintext,
      encrypted: encrypted.payload,
      encryption: encrypted.encryption,
      verification: { schemaVersion: 5, rowCounts: {}, samples: [] },
    });
    const tampered = Buffer.from(encrypted.payload);
    tampered[0] = (tampered[0] ?? 0) ^ 1;

    expect(() => verifyBackupPayload(tampered, manifest)).toThrow(
      /ciphertext checksum/i,
    );
    expect(() => decryptBackup(tampered, manifest, key)).toThrow();
  });

  it("requires production backups to use a different account and bucket", () => {
    expect(() =>
      assertBackupIsolation({
        environment: "production",
        sourceAccountId: "same-account",
        destinationAccountId: "same-account",
        contentBucket: "primary-content",
        backupBucket: "primary-content",
      }),
    ).toThrow(/separate account/i);
    expect(() =>
      assertBackupIsolation({
        environment: "production",
        sourceAccountId: "source-account",
        destinationAccountId: "backup-account",
        contentBucket: "primary-content",
        backupBucket: "primary-content",
      }),
    ).toThrow(/separate bucket/i);
    expect(() =>
      assertBackupIsolation({
        environment: "production",
        sourceAccountId: "source-account",
        destinationAccountId: "backup-account",
        contentBucket: "primary-content",
        backupBucket: "backup-content",
      }),
    ).not.toThrow();
  });

  it("exports, verifies, encrypts and atomically records a resumable backup", async () => {
    const outputDirectory = await mkdtemp(join(tmpdir(), "oa-backup-test-"));
    const commands: string[][] = [];
    const runner = async (args: string[]) => {
      commands.push(args);
      if (args.includes("export")) {
        const outputFlag = args.find((argument) =>
          argument.startsWith("--output="),
        );
        if (!outputFlag) throw new Error("missing output flag");
        await writeFile(
          outputFlag.slice("--output=".length),
          "CREATE TABLE artifacts(id TEXT);\n",
        );
        return { stdout: "exported", stderr: "" };
      }
      if (args.includes("time-travel")) {
        return { stdout: JSON.stringify({ bookmark: "bookmark-current" }) };
      }
      const sql = args.at(-1) ?? "";
      if (sql.includes("schema_version")) {
        return {
          stdout: JSON.stringify([{ results: [{ schema_version: 5 }] }]),
        };
      }
      if (sql.includes("table_name")) {
        return {
          stdout: JSON.stringify([
            {
              results: [
                { table_name: "artifacts", row_count: 1 },
                { table_name: "versions", row_count: 1 },
                { table_name: "comments", row_count: 0 },
                { table_name: "handoffs", row_count: 0 },
                { table_name: "publications", row_count: 1 },
              ],
            },
          ]),
        };
      }
      return {
        stdout: JSON.stringify([
          {
            results: [
              { artifact_id: "a-1", version: 1, content_hash: "hash-1" },
            ],
          },
        ]),
      };
    };
    try {
      const report = await runBackup({
        args: parseBackupArgs([
          "--environment",
          "staging",
          "--database",
          "staging-db",
          "--database-id",
          "source-db",
          "--source-account-id",
          "source-account",
          "--content-bucket",
          "content-bucket",
          "--backup-account-id",
          "backup-account",
          "--backup-bucket",
          "backup-bucket",
          "--output-dir",
          outputDirectory,
          "--config",
          "wrangler.staging.jsonc",
          "--key-id",
          "backup-key-2026-q3",
          "--retention-days",
          "90",
        ]),
        environment: { OPEN_ARTIFACTS_BACKUP_KEY: key },
        runner,
        now: () => new Date("2026-08-04T12:00:00.000Z"),
      });
      const manifest = JSON.parse(await readFile(report.manifestPath, "utf8"));
      const payload = await readFile(report.payloadPath);

      expect(report).toMatchObject({
        backupId: "backup-20260804T120000000Z",
        uploaded: false,
      });
      expect(manifest.bookmark).toBe("bookmark-current");
      expect(manifest.verification).toMatchObject({
        schemaVersion: 5,
        rowCounts: { artifacts: 1, versions: 1 },
      });
      expect(decryptBackup(payload, manifest, key).toString()).toContain(
        "CREATE TABLE artifacts",
      );
      expect(commands.some((args) => args.includes("export"))).toBe(true);
      expect(JSON.stringify(commands)).not.toContain(key);
    } finally {
      await rm(outputDirectory, { recursive: true, force: true });
    }
  });
});
