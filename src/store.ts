import type {
  ArtifactFormat,
  ArtifactMeta,
  CreateInput,
  EncryptionParams,
  UpdateInput,
  VersionMeta,
} from "./domain";

export interface ArtifactRecord extends ArtifactMeta {
  tokenHash: string;
}

export interface StoredContent {
  body: string;
  encrypted: EncryptionParams | null;
}

export interface ArtifactStore {
  create(
    id: string,
    tokenHash: string,
    input: CreateInput,
  ): Promise<ArtifactRecord>;
  get(id: string): Promise<ArtifactRecord | null>;
  listVersions(id: string): Promise<VersionMeta[]>;
  getContent(id: string, version: number): Promise<StoredContent | null>;
  update(
    record: ArtifactRecord,
    input: UpdateInput,
  ): Promise<number | { conflict: true; currentVersion: number }>;
  delete(id: string): Promise<void>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    favicon TEXT NOT NULL,
    format TEXT NOT NULL,
    encrypted INTEGER NOT NULL DEFAULT 0,
    current_version INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS versions (
    artifact_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    label TEXT,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (artifact_id, version)
  )`,
];

let schemaReady: Promise<unknown> | undefined;

function ensureSchema(db: D1Database): Promise<unknown> {
  // Reset the memoized promise if the previous attempt failed, so a transient
  // D1 error does not poison every subsequent request in this isolate.
  schemaReady ??= db
    .batch(SCHEMA.map((sql) => db.prepare(sql)))
    .catch((error) => {
      schemaReady = undefined;
      throw error;
    });
  return schemaReady;
}

interface ArtifactRow {
  id: string;
  token_hash: string;
  title: string;
  description: string;
  favicon: string;
  format: string;
  encrypted: number;
  current_version: number;
  created_at: string;
  updated_at: string;
}

function toRecord(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    title: row.title,
    description: row.description,
    favicon: row.favicon,
    format: row.format as ArtifactFormat,
    encrypted: row.encrypted === 1,
    currentVersion: row.current_version,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

const contentKey = (id: string, version: number) => `content/${id}/${version}`;

interface Envelope extends EncryptionParams {
  v: 1;
  alg: "AES-GCM";
  kdf: "PBKDF2-SHA256";
  ciphertext: string;
}

function contentObjectBody(
  content: string,
  encrypted: EncryptionParams | null,
): string {
  if (encrypted === null) return content;
  const envelope: Envelope = {
    v: 1,
    alg: "AES-GCM",
    kdf: "PBKDF2-SHA256",
    iterations: encrypted.iterations,
    salt: encrypted.salt,
    iv: encrypted.iv,
    ciphertext: content,
  };
  return JSON.stringify(envelope);
}

export class D1R2Store implements ArtifactStore {
  constructor(
    private readonly db: D1Database,
    private readonly bucket: R2Bucket,
  ) {}

  async create(
    id: string,
    tokenHash: string,
    input: CreateInput,
  ): Promise<ArtifactRecord> {
    await ensureSchema(this.db);
    const now = new Date().toISOString();
    const encrypted = input.encrypted !== null;
    await this.bucket.put(
      contentKey(id, 1),
      contentObjectBody(input.content, input.encrypted),
      {
        customMetadata: { encrypted: encrypted ? "1" : "0" },
      },
    );
    await this.db.batch([
      this.db
        .prepare(
          `INSERT INTO artifacts (id, token_hash, title, description, favicon, format, encrypted, current_version, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, 1, ?, ?)`,
        )
        .bind(
          id,
          tokenHash,
          input.title,
          input.description,
          input.favicon,
          input.format,
          input.encrypted ? 1 : 0,
          now,
          now,
        ),
      this.db
        .prepare(
          "INSERT INTO versions (artifact_id, version, label, size, created_at) VALUES (?, 1, ?, ?, ?)",
        )
        .bind(id, input.label, input.content.length, now),
    ]);
    return {
      id,
      tokenHash,
      title: input.title,
      description: input.description,
      favicon: input.favicon,
      format: input.format,
      encrypted: input.encrypted !== null,
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
    };
  }

  async get(id: string): Promise<ArtifactRecord | null> {
    await ensureSchema(this.db);
    const row = await this.db
      .prepare("SELECT * FROM artifacts WHERE id = ?")
      .bind(id)
      .first<ArtifactRow>();
    return row ? toRecord(row) : null;
  }

  async listVersions(id: string): Promise<VersionMeta[]> {
    await ensureSchema(this.db);
    const { results } = await this.db
      .prepare(
        "SELECT version, label, size, created_at FROM versions WHERE artifact_id = ? ORDER BY version ASC",
      )
      .bind(id)
      .all<{
        version: number;
        label: string | null;
        size: number;
        created_at: string;
      }>();
    return results.map((row) => ({
      version: row.version,
      label: row.label,
      size: row.size,
      createdAt: row.created_at,
    }));
  }

  async getContent(id: string, version: number): Promise<StoredContent | null> {
    const object = await this.bucket.get(contentKey(id, version));
    if (object === null) return null;
    const body = await object.text();
    // Per-version flag, not the artifact's current state: an artifact can
    // switch between encrypted and plain across versions, and each version
    // must be parsed by its own encryption state.
    const encrypted = object.customMetadata?.encrypted === "1";
    if (encrypted) {
      const envelope = JSON.parse(body) as Envelope;
      return {
        body: envelope.ciphertext,
        encrypted: {
          salt: envelope.salt,
          iv: envelope.iv,
          iterations: envelope.iterations,
        },
      };
    }
    return { body, encrypted: null };
  }

  async update(
    record: ArtifactRecord,
    input: UpdateInput,
  ): Promise<number | { conflict: true; currentVersion: number }> {
    const now = new Date().toISOString();
    const version = record.currentVersion + 1;
    const encrypted = input.encrypted !== null;

    // Compare-and-swap on D1 first: only advance current_version if it still
    // matches the snapshot we read. This makes concurrent PUTs safe — exactly
    // one wins, the rest get a conflict — and we only write R2 once D1 has
    // accepted the new version, so an R2 object is never orphaned from D1.
    const claimed = await this.db
      .prepare(
        `UPDATE artifacts
         SET title = ?, description = ?, favicon = ?, format = ?, encrypted = ?, current_version = ?, updated_at = ?
         WHERE id = ? AND current_version = ?`,
      )
      .bind(
        input.title ?? record.title,
        input.description ?? record.description,
        input.favicon ?? record.favicon,
        input.format ?? record.format,
        input.encrypted ? 1 : 0,
        version,
        now,
        record.id,
        record.currentVersion,
      )
      .run();

    if (claimed.meta.changes === 0) {
      const fresh = await this.get(record.id);
      return {
        conflict: true,
        currentVersion: fresh?.currentVersion ?? version,
      };
    }

    await this.bucket.put(
      contentKey(record.id, version),
      contentObjectBody(input.content, input.encrypted),
      { customMetadata: { encrypted: encrypted ? "1" : "0" } },
    );
    await this.db
      .prepare(
        "INSERT INTO versions (artifact_id, version, label, size, created_at) VALUES (?, ?, ?, ?, ?)",
      )
      .bind(record.id, version, input.label, input.content.length, now)
      .run();

    return version;
  }

  async delete(id: string): Promise<void> {
    await ensureSchema(this.db);
    const objects = await this.bucket.list({ prefix: `content/${id}/` });
    if (objects.objects.length > 0) {
      await this.bucket.delete(objects.objects.map((o) => o.key));
    }
    await this.db.batch([
      this.db.prepare("DELETE FROM versions WHERE artifact_id = ?").bind(id),
      this.db.prepare("DELETE FROM artifacts WHERE id = ?").bind(id),
    ]);
  }
}
