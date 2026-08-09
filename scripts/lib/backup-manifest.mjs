import {
  createCipheriv,
  createDecipheriv,
  createHash,
  randomBytes,
  timingSafeEqual,
} from "node:crypto";
import { chmod, open, rename } from "node:fs/promises";
import { dirname } from "node:path";

/** @typedef {{artifactId: string, version: number, contentHash: string}} BackupSample */
/** @typedef {{schemaVersion: number, rowCounts: Record<string, number>, samples: BackupSample[]}} BackupVerification */
/** @typedef {{environment: string, accountId: string, databaseId: string, databaseName: string}} BackupSource */
/** @typedef {{accountId: string, bucket: string, objectKey: string}} BackupDestination */
/** @typedef {{algorithm: "aes-256-gcm", keyId: string, iv: string, authTagBytes: number}} BackupEncryption */
/**
 * @typedef {{
 *   schemaVersion: 1,
 *   backupId: string,
 *   source: BackupSource,
 *   destination: BackupDestination,
 *   createdAt: string,
 *   expiresAt: string,
 *   bookmark: string,
 *   encryption: BackupEncryption,
 *   checksums: {plaintextSha256: string, ciphertextSha256: string},
 *   byteLength: {plaintext: number, ciphertext: number},
 *   verification: BackupVerification,
 *   immutable: true
 * }} BackupManifest
 */

const SHA256_PATTERN = /^[a-f0-9]{64}$/;

/** @param {Buffer | Uint8Array | string} value */
export function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** @param {string} encoded */
export function decodeBackupKey(encoded) {
  if (!encoded || !/^[A-Za-z0-9+/]+={0,2}$/.test(encoded)) {
    throw new Error("backup key must be canonical base64");
  }
  const key = Buffer.from(encoded, "base64");
  if (key.length !== 32 || key.toString("base64") !== encoded) {
    throw new Error("backup key must decode to exactly 32 bytes");
  }
  return key;
}

/**
 * @param {Buffer | Uint8Array} plaintext
 * @param {string} encodedKey
 * @param {{iv?: Buffer | Uint8Array, keyId: string}} options
 */
export function encryptBackup(plaintext, encodedKey, options) {
  const key = decodeBackupKey(encodedKey);
  const iv = Buffer.from(options.iv ?? randomBytes(12));
  if (iv.length !== 12) throw new Error("AES-GCM IV must be 12 bytes");
  if (!/^[a-zA-Z0-9._-]{3,80}$/.test(options.keyId)) {
    throw new Error("backup key ID is invalid");
  }
  const cipher = createCipheriv("aes-256-gcm", key, iv, {
    authTagLength: 16,
  });
  const ciphertext = Buffer.concat([
    cipher.update(Buffer.from(plaintext)),
    cipher.final(),
  ]);
  const payload = Buffer.concat([ciphertext, cipher.getAuthTag()]);
  return {
    payload,
    encryption: /** @type {BackupEncryption} */ ({
      algorithm: "aes-256-gcm",
      keyId: options.keyId,
      iv: iv.toString("base64"),
      authTagBytes: 16,
    }),
  };
}

/** @param {Buffer | Uint8Array} payload @param {BackupManifest} manifest */
export function verifyBackupPayload(payload, manifest) {
  validateBackupManifest(manifest);
  const actual = Buffer.from(sha256Hex(payload), "hex");
  const expected = Buffer.from(manifest.checksums.ciphertextSha256, "hex");
  if (
    actual.length !== expected.length ||
    !timingSafeEqual(actual, expected) ||
    payload.byteLength !== manifest.byteLength.ciphertext
  ) {
    throw new Error("backup ciphertext checksum or size mismatch");
  }
  return true;
}

/**
 * @param {Buffer | Uint8Array} payload
 * @param {BackupManifest} manifest
 * @param {string} encodedKey
 */
export function decryptBackup(payload, manifest, encodedKey) {
  verifyBackupPayload(payload, manifest);
  const key = decodeBackupKey(encodedKey);
  const bytes = Buffer.from(payload);
  const tagBytes = manifest.encryption.authTagBytes;
  if (bytes.length <= tagBytes) throw new Error("backup payload is truncated");
  const decipher = createDecipheriv(
    "aes-256-gcm",
    key,
    Buffer.from(manifest.encryption.iv, "base64"),
    { authTagLength: tagBytes },
  );
  decipher.setAuthTag(bytes.subarray(bytes.length - tagBytes));
  const plaintext = Buffer.concat([
    decipher.update(bytes.subarray(0, bytes.length - tagBytes)),
    decipher.final(),
  ]);
  if (
    plaintext.length !== manifest.byteLength.plaintext ||
    sha256Hex(plaintext) !== manifest.checksums.plaintextSha256
  ) {
    throw new Error("backup plaintext checksum or size mismatch");
  }
  return plaintext;
}

/**
 * @param {{
 *   backupId: string,
 *   source: BackupSource,
 *   destination: BackupDestination,
 *   createdAt: string,
 *   expiresAt: string,
 *   bookmark: string,
 *   plaintext: Buffer | Uint8Array,
 *   encrypted: Buffer | Uint8Array,
 *   encryption: BackupEncryption,
 *   verification: BackupVerification
 * }} input
 * @returns {BackupManifest}
 */
export function createBackupManifest(input) {
  const manifest = /** @type {BackupManifest} */ ({
    schemaVersion: 1,
    backupId: input.backupId,
    source: input.source,
    destination: input.destination,
    createdAt: input.createdAt,
    expiresAt: input.expiresAt,
    bookmark: input.bookmark,
    encryption: input.encryption,
    checksums: {
      plaintextSha256: sha256Hex(input.plaintext),
      ciphertextSha256: sha256Hex(input.encrypted),
    },
    byteLength: {
      plaintext: input.plaintext.byteLength,
      ciphertext: input.encrypted.byteLength,
    },
    verification: input.verification,
    immutable: true,
  });
  validateBackupManifest(manifest);
  return manifest;
}

/** @param {unknown} candidate @returns {asserts candidate is BackupManifest} */
export function validateBackupManifest(candidate) {
  if (!candidate || typeof candidate !== "object") {
    throw new Error("backup manifest must be an object");
  }
  const manifest = /** @type {BackupManifest} */ (candidate);
  if (manifest.schemaVersion !== 1 || manifest.immutable !== true) {
    throw new Error("unsupported or mutable backup manifest");
  }
  for (const [label, value] of [
    ["backup ID", manifest.backupId],
    ["source environment", manifest.source?.environment],
    ["source account", manifest.source?.accountId],
    ["source database", manifest.source?.databaseId],
    ["destination account", manifest.destination?.accountId],
    ["destination bucket", manifest.destination?.bucket],
    ["destination object key", manifest.destination?.objectKey],
    ["Time Travel bookmark", manifest.bookmark],
  ]) {
    if (typeof value !== "string" || value.length < 2) {
      throw new Error(`${label} is missing from backup manifest`);
    }
  }
  if (
    !SHA256_PATTERN.test(manifest.checksums?.plaintextSha256 ?? "") ||
    !SHA256_PATTERN.test(manifest.checksums?.ciphertextSha256 ?? "")
  ) {
    throw new Error("backup manifest checksums are invalid");
  }
  if (
    manifest.encryption?.algorithm !== "aes-256-gcm" ||
    manifest.encryption.authTagBytes !== 16 ||
    Buffer.from(manifest.encryption.iv ?? "", "base64").length !== 12
  ) {
    throw new Error("backup encryption metadata is invalid");
  }
  if (
    !Number.isInteger(manifest.verification?.schemaVersion) ||
    !manifest.verification?.rowCounts ||
    !Array.isArray(manifest.verification?.samples)
  ) {
    throw new Error("backup verification metadata is invalid");
  }
  const created = Date.parse(manifest.createdAt);
  const expires = Date.parse(manifest.expiresAt);
  if (
    !Number.isFinite(created) ||
    !Number.isFinite(expires) ||
    expires <= created
  ) {
    throw new Error("backup retention timestamps are invalid");
  }
}

/**
 * @param {{
 *   environment: string,
 *   sourceAccountId: string,
 *   destinationAccountId: string,
 *   contentBucket: string,
 *   backupBucket: string
 * }} input
 */
export function assertBackupIsolation(input) {
  if (
    input.environment === "production" &&
    input.sourceAccountId === input.destinationAccountId
  ) {
    throw new Error("production backups require a separate account");
  }
  if (!input.backupBucket || input.backupBucket === input.contentBucket) {
    throw new Error("backups require a separate bucket from primary content");
  }
}

/** @param {string} filePath @param {Buffer | string} contents */
export async function atomicWritePrivate(filePath, contents) {
  const temporaryPath = `${filePath}.tmp-${process.pid}-${randomBytes(6).toString("hex")}`;
  const handle = await open(temporaryPath, "wx", 0o600);
  try {
    await handle.writeFile(contents);
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporaryPath, filePath);
  await chmod(filePath, 0o600);
  const directory = await open(dirname(filePath), "r");
  try {
    await directory.sync();
  } finally {
    await directory.close();
  }
}
