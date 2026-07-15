import type {
  ArtifactFormat,
  ArtifactMeta,
  CreateInput,
  EncryptionParams,
  FeedbackInput,
  FeedbackRecord,
  FeedbackStatus,
  UpdateInput,
  VersionMeta,
} from "./domain";
import { contentByteLength } from "./domain";
import { generateId } from "./tokens";

export interface ArtifactRecord extends ArtifactMeta {
  tokenHash: string;
  channelHash: string | null;
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
    channelHash: string | null,
  ): Promise<ArtifactRecord>;
  get(id: string): Promise<ArtifactRecord | null>;
  findByChannel(channelHash: string): Promise<ArtifactRecord | null>;
  listVersions(id: string): Promise<VersionMeta[]>;
  getContent(id: string, version: number): Promise<StoredContent | null>;
  update(
    record: ArtifactRecord,
    input: UpdateInput,
  ): Promise<number | { conflict: true; currentVersion: number }>;
  delete(id: string): Promise<void>;
  addFeedback(
    artifactId: string,
    input: FeedbackInput,
  ): Promise<FeedbackRecord>;
  listFeedback(
    artifactId: string,
    status?: FeedbackStatus,
  ): Promise<FeedbackRecord[]>;
  getFeedback(id: string): Promise<FeedbackRecord | null>;
  updateFeedbackStatus(
    id: string,
    status: FeedbackStatus,
  ): Promise<FeedbackRecord | null>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS artifacts (
    id TEXT PRIMARY KEY,
    token_hash TEXT NOT NULL,
    channel_hash TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    favicon TEXT NOT NULL,
    format TEXT NOT NULL,
    encrypted INTEGER NOT NULL DEFAULT 0,
    current_version INTEGER NOT NULL,
    project_ref TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL
  )`,
  `CREATE TABLE IF NOT EXISTS versions (
    artifact_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    label TEXT,
    title TEXT NOT NULL,
    description TEXT NOT NULL DEFAULT '',
    favicon TEXT NOT NULL,
    format TEXT NOT NULL,
    encrypted INTEGER NOT NULL DEFAULT 0,
    size INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (artifact_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    project_ref TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_artifact_status ON feedback(artifact_id, status)`,
];

// Columns added after launch; migrate existing DBs in place. Each ALTER
// errors if the column already exists, which is fine — the column is there.
// The unique index makes channel binding race-safe: concurrent first
// publishes to one channel can only mint one artifact (SQLite allows any
// number of NULLs, so channel-less artifacts are unaffected).
const MIGRATIONS = [
  `ALTER TABLE artifacts ADD COLUMN channel_hash TEXT`,
  `ALTER TABLE artifacts ADD COLUMN project_ref TEXT`,
  `ALTER TABLE versions ADD COLUMN title TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE versions ADD COLUMN description TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE versions ADD COLUMN favicon TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE versions ADD COLUMN format TEXT NOT NULL DEFAULT 'html'`,
  `ALTER TABLE versions ADD COLUMN encrypted INTEGER NOT NULL DEFAULT 0`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_channel_hash ON artifacts(channel_hash)`,
];

// After the ALTERs above add columns to existing rows with empty defaults,
// backfill those rows from the parent artifact so historical versions keep
// their metadata. Runs once per fresh column; a no-op once data is present.
const BACKFILL = `
UPDATE versions
SET title = (SELECT title FROM artifacts WHERE artifacts.id = versions.artifact_id),
    description = (SELECT description FROM artifacts WHERE artifacts.id = versions.artifact_id),
    favicon = (SELECT favicon FROM artifacts WHERE artifacts.id = versions.artifact_id),
    format = (SELECT format FROM artifacts WHERE artifacts.id = versions.artifact_id),
    encrypted = (SELECT encrypted FROM artifacts WHERE artifacts.id = versions.artifact_id)
WHERE title = '' AND favicon = ''
`;

// "duplicate column name": the ALTER already ran on this database.
// "UNIQUE constraint failed": the index cannot cover legacy duplicate rows.
// Anything else is a genuine failure worth surfacing in the logs.
const isExpectedMigrationError = (error: unknown): boolean =>
  error instanceof Error &&
  /duplicate column name|UNIQUE constraint failed/.test(error.message);

// Memoized per database so a second binding (or a fresh test database in the
// same isolate) never skips its own setup. A failed attempt clears the memo,
// so a transient D1 error does not poison every subsequent request.
const schemaReady = new WeakMap<D1Database, Promise<unknown>>();

async function ensureSchema(db: D1Database): Promise<unknown> {
  const pending = schemaReady.get(db);
  if (pending) return pending;
  const run = async () => {
    await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
    // Statements run via prepare(), not exec(): exec() splits its input on
    // newlines and rejects multi-line statements like BACKFILL. Sequential,
    // not parallel: the unique index depends on the channel_hash ALTER having
    // run first on a pre-channel database. Failures don't block requests, but
    // only the expected ones — column already added, or an index blocked by
    // legacy duplicate rows (findByChannel orders those deterministically) —
    // stay silent.
    for (const sql of MIGRATIONS) {
      await db
        .prepare(sql)
        .run()
        .catch((error) => {
          if (!isExpectedMigrationError(error)) {
            console.warn("migration failed, continuing:", sql, error);
          }
        });
    }
    // Backfill historical version rows that got empty defaults from the
    // ALTER above. No-op once rows are populated.
    await db
      .prepare(BACKFILL)
      .run()
      .catch((error) => console.warn("version backfill failed:", error));
  };
  const attempt = run().catch((error) => {
    schemaReady.delete(db);
    throw error;
  });
  schemaReady.set(db, attempt);
  return attempt;
}

interface ArtifactRow {
  id: string;
  token_hash: string;
  channel_hash: string | null;
  title: string;
  description: string;
  favicon: string;
  format: string;
  encrypted: number;
  current_version: number;
  project_ref: string | null;
  created_at: string;
  updated_at: string;
}

interface FeedbackRow {
  id: string;
  artifact_id: string;
  project_ref: string | null;
  body: string;
  status: string;
  created_at: string;
}

function toFeedbackRecord(row: FeedbackRow): FeedbackRecord {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    projectRef: row.project_ref,
    body: row.body,
    status: row.status as FeedbackStatus,
    createdAt: row.created_at,
  };
}

function toRecord(row: ArtifactRow): ArtifactRecord {
  return {
    id: row.id,
    tokenHash: row.token_hash,
    channelHash: row.channel_hash,
    title: row.title,
    description: row.description,
    favicon: row.favicon,
    format: row.format as ArtifactFormat,
    encrypted: row.encrypted === 1,
    currentVersion: row.current_version,
    projectRef: row.project_ref,
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
    channelHash: string | null,
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
    const insert = this.db.batch([
      this.db
        .prepare(
          `INSERT INTO artifacts (id, token_hash, channel_hash, title, description, favicon, format, encrypted, current_version, project_ref, created_at, updated_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?)`,
        )
        .bind(
          id,
          tokenHash,
          channelHash,
          input.title,
          input.description,
          input.favicon,
          input.format,
          input.encrypted ? 1 : 0,
          input.projectRef,
          now,
          now,
        ),
      this.db
        .prepare(
          `INSERT INTO versions (artifact_id, version, label, title, description, favicon, format, encrypted, size, created_at)
           VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          id,
          input.label,
          input.title,
          input.description,
          input.favicon,
          input.format,
          input.encrypted ? 1 : 0,
          contentByteLength(input.content),
          now,
        ),
    ]);
    // The unique channel index makes a failed insert an expected outcome of
    // racing first publishes; sweep the object written above so the discarded
    // id leaves nothing behind in the bucket.
    await insert.catch(async (error) => {
      await this.bucket.delete(contentKey(id, 1)).catch(() => {});
      throw error;
    });
    return {
      id,
      tokenHash,
      channelHash,
      title: input.title,
      description: input.description,
      favicon: input.favicon,
      format: input.format,
      encrypted: input.encrypted !== null,
      currentVersion: 1,
      projectRef: input.projectRef,
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

  async findByChannel(channelHash: string): Promise<ArtifactRecord | null> {
    await ensureSchema(this.db);
    // The unique index caps this at one row; ORDER BY keeps the pick
    // deterministic (oldest binding wins, id as tiebreaker) on a legacy DB
    // where duplicates predate the index.
    const row = await this.db
      .prepare(
        "SELECT * FROM artifacts WHERE channel_hash = ? ORDER BY created_at, id LIMIT 1",
      )
      .bind(channelHash)
      .first<ArtifactRow>();
    return row ? toRecord(row) : null;
  }

  async listVersions(id: string): Promise<VersionMeta[]> {
    await ensureSchema(this.db);
    const { results } = await this.db
      .prepare(
        `SELECT version, label, title, description, favicon, format, encrypted, size, created_at
         FROM versions WHERE artifact_id = ? ORDER BY version ASC`,
      )
      .bind(id)
      .all<{
        version: number;
        label: string | null;
        title: string;
        description: string;
        favicon: string;
        format: string;
        encrypted: number;
        size: number;
        created_at: string;
      }>();
    return results.map((row) => ({
      version: row.version,
      label: row.label,
      title: row.title,
      description: row.description,
      favicon: row.favicon,
      format: row.format as ArtifactFormat,
      encrypted: row.encrypted === 1,
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
         SET title = ?, description = ?, favicon = ?, format = ?, encrypted = ?, current_version = ?, project_ref = ?, updated_at = ?
         WHERE id = ? AND current_version = ?`,
      )
      .bind(
        input.title ?? record.title,
        input.description ?? record.description,
        input.favicon ?? record.favicon,
        input.format ?? record.format,
        input.encrypted ? 1 : 0,
        version,
        input.projectRef ?? record.projectRef,
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

    const vTitle = input.title ?? record.title;
    const vDescription = input.description ?? record.description;
    const vFavicon = input.favicon ?? record.favicon;
    const vFormat = input.format ?? record.format;

    await this.bucket.put(
      contentKey(record.id, version),
      contentObjectBody(input.content, input.encrypted),
      { customMetadata: { encrypted: encrypted ? "1" : "0" } },
    );
    await this.db
      .prepare(
        `INSERT INTO versions (artifact_id, version, label, title, description, favicon, format, encrypted, size, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .bind(
        record.id,
        version,
        input.label,
        vTitle,
        vDescription,
        vFavicon,
        vFormat,
        input.encrypted ? 1 : 0,
        contentByteLength(input.content),
        now,
      )
      .run();

    return version;
  }

  async delete(id: string): Promise<void> {
    await ensureSchema(this.db);
    // list() returns at most 1000 keys per page (delete() accepts at most as
    // many), so drain page by page — an artifact republished from a channel
    // can easily accumulate more versions than one page holds.
    for (;;) {
      const page = await this.bucket.list({ prefix: `content/${id}/` });
      if (page.objects.length > 0) {
        await this.bucket.delete(page.objects.map((o) => o.key));
      }
      if (!page.truncated) break;
    }
    await this.db.batch([
      this.db.prepare("DELETE FROM versions WHERE artifact_id = ?").bind(id),
      this.db.prepare("DELETE FROM feedback WHERE artifact_id = ?").bind(id),
      this.db.prepare("DELETE FROM artifacts WHERE id = ?").bind(id),
    ]);
  }

  async addFeedback(
    artifactId: string,
    input: FeedbackInput,
  ): Promise<FeedbackRecord> {
    await ensureSchema(this.db);
    const id = generateId();
    const now = new Date().toISOString();
    await this.db
      .prepare(
        `INSERT INTO feedback (id, artifact_id, project_ref, body, status, created_at)
         VALUES (?, ?, ?, ?, 'pending', ?)`,
      )
      .bind(id, artifactId, input.projectRef, input.body, now)
      .run();
    return {
      id,
      artifactId,
      projectRef: input.projectRef,
      body: input.body,
      status: "pending",
      createdAt: now,
    };
  }

  async listFeedback(
    artifactId: string,
    status?: FeedbackStatus,
  ): Promise<FeedbackRecord[]> {
    await ensureSchema(this.db);
    const stmt =
      status === undefined
        ? this.db.prepare(
            "SELECT * FROM feedback WHERE artifact_id = ? ORDER BY created_at ASC",
          )
        : this.db.prepare(
            "SELECT * FROM feedback WHERE artifact_id = ? AND status = ? ORDER BY created_at ASC",
          );
    const bound =
      status === undefined
        ? stmt.bind(artifactId)
        : stmt.bind(artifactId, status);
    const { results } = await bound.all<FeedbackRow>();
    return results.map(toFeedbackRecord);
  }

  async getFeedback(id: string): Promise<FeedbackRecord | null> {
    await ensureSchema(this.db);
    const row = await this.db
      .prepare("SELECT * FROM feedback WHERE id = ?")
      .bind(id)
      .first<FeedbackRow>();
    return row ? toFeedbackRecord(row) : null;
  }

  async updateFeedbackStatus(
    id: string,
    status: FeedbackStatus,
  ): Promise<FeedbackRecord | null> {
    await ensureSchema(this.db);
    await this.db
      .prepare("UPDATE feedback SET status = ? WHERE id = ?")
      .bind(status, id)
      .run();
    return this.getFeedback(id);
  }
}
