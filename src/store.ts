import type {
  Anchor,
  ArtifactFormat,
  ArtifactMeta,
  CommentInput,
  CommentMeta,
  CreateInput,
  EncryptionParams,
  FeedbackInput,
  FeedbackRecord,
  FeedbackStatus,
  RateLimitRule,
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
  // Authoritative per-version encrypted flag without reading the ≤4 MiB body.
  // The versions-table flag can be stale on legacy mixed-encryption artifacts
  // (the ensureSchema backfill stamps it from the artifact's current state),
  // so the host route reads R2 object metadata instead.
  getContentMeta(
    id: string,
    version: number,
  ): Promise<{ encrypted: boolean } | null>;
  update(
    record: ArtifactRecord,
    input: UpdateInput,
  ): Promise<number | { conflict: true; currentVersion: number }>;
  delete(id: string): Promise<void>;
  listComments(artifactId: string): Promise<CommentMeta[]>;
  addComment(
    artifactId: string,
    input: CommentInput,
    deleteTokenHash?: string | null,
  ): Promise<CommentMeta>;
  getComment(
    commentId: string,
  ): Promise<{ artifactId: string; deleteTokenHash: string | null } | null>;
  setCommentDone(commentId: string, done: boolean): Promise<boolean>;
  deleteComment(commentId: string): Promise<void>;
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
  deleteFeedback(id: string): Promise<void>;
  // Spend one token from `key`'s bucket. `now` is epoch ms, injected so the
  // time-dependent behavior is testable without a clock.
  consumeToken(
    key: string,
    rule: RateLimitRule,
    now: number,
  ): Promise<{ allowed: boolean }>;
}

// Max feedback rows one poll returns. Exported so the CLI can tell the agent
// when a page is full and more may be waiting behind it.
export const FEEDBACK_PAGE_LIMIT = 100;

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
  `CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    author TEXT,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_comments_artifact_created
    ON comments(artifact_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS feedback (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    project_ref TEXT,
    body TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_feedback_artifact_status ON feedback(artifact_id, status)`,
  // Token buckets for anonymous writes (R5). Timestamps are REAL epoch seconds
  // rather than the ISO TEXT used elsewhere because refill is arithmetic on
  // them, done in SQL. Rows are spent state, not content: they are pruned once
  // fully refilled, so this table stays bounded by recent write activity.
  `CREATE TABLE IF NOT EXISTS rate_limits (
    bucket_key TEXT PRIMARY KEY,
    tokens REAL NOT NULL,
    updated_at REAL NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_rate_limits_updated
    ON rate_limits(updated_at)`,
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
  // Anchored comments (#5): nullable JSON anchor + per-comment delete-token hash.
  // Legacy rows read NULL for both — unanchored and owner-removable only.
  `ALTER TABLE comments ADD COLUMN anchor TEXT`,
  `ALTER TABLE comments ADD COLUMN delete_token_hash TEXT`,
  // Soft "done" / resolved flag — open toggle for all viewers (not delete).
  `ALTER TABLE comments ADD COLUMN done INTEGER NOT NULL DEFAULT 0`,
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

  async getContentMeta(
    id: string,
    version: number,
  ): Promise<{ encrypted: boolean } | null> {
    // head() returns the R2 object's metadata without streaming the body —
    // the authoritative per-version encrypted flag, which the versions-table
    // flag is not on legacy mixed-encryption artifacts.
    const object = await this.bucket.head(contentKey(id, version));
    if (object === null) return null;
    return { encrypted: object.customMetadata?.encrypted === "1" };
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
      this.db.prepare("DELETE FROM artifacts WHERE id = ?").bind(id),
      this.db.prepare("DELETE FROM comments WHERE artifact_id = ?").bind(id),
      this.db.prepare("DELETE FROM feedback WHERE artifact_id = ?").bind(id),
    ]);
  }

  async listComments(artifactId: string): Promise<CommentMeta[]> {
    await ensureSchema(this.db);
    // Cap at 100 to bound inlined HTML. Keep the *newest* window (DESC LIMIT),
    // then reverse so callers still see chronological oldest-first. ASC LIMIT
    // would freeze on the first 100 and hide every subsequent post.
    const { results } = await this.db
      .prepare(
        `SELECT id, artifact_id, author, body, anchor, done, created_at
         FROM comments WHERE artifact_id = ?
         ORDER BY created_at DESC, id DESC LIMIT 100`,
      )
      .bind(artifactId)
      .all<CommentRow>();
    return results.map(toComment).reverse();
  }

  async addComment(
    artifactId: string,
    input: CommentInput,
    deleteTokenHash: string | null = null,
  ): Promise<CommentMeta> {
    await ensureSchema(this.db);
    const id = generateId();
    const now = new Date().toISOString();
    const anchorJson = input.anchor ? JSON.stringify(input.anchor) : null;
    await this.db
      .prepare(
        `INSERT INTO comments (id, artifact_id, author, body, anchor, delete_token_hash, done, created_at)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)`,
      )
      .bind(
        id,
        artifactId,
        input.author,
        input.body,
        anchorJson,
        deleteTokenHash,
        now,
      )
      .run();
    return {
      id,
      artifactId,
      author: input.author,
      body: input.body,
      anchor: input.anchor,
      done: false,
      createdAt: now,
    };
  }

  // Delete authorization needs only the owning artifact and the stored token
  // hash; the hash never leaves the server and is never part of CommentMeta.
  async getComment(
    commentId: string,
  ): Promise<{ artifactId: string; deleteTokenHash: string | null } | null> {
    await ensureSchema(this.db);
    const row = await this.db
      .prepare(
        "SELECT artifact_id, delete_token_hash FROM comments WHERE id = ?",
      )
      .bind(commentId)
      .first<{ artifact_id: string; delete_token_hash: string | null }>();
    return row
      ? { artifactId: row.artifact_id, deleteTokenHash: row.delete_token_hash }
      : null;
  }

  /** Returns false if the comment row does not exist. */
  async setCommentDone(commentId: string, done: boolean): Promise<boolean> {
    await ensureSchema(this.db);
    const result = await this.db
      .prepare("UPDATE comments SET done = ? WHERE id = ?")
      .bind(done ? 1 : 0, commentId)
      .run();
    return (result.meta.changes ?? 0) > 0;
  }

  async deleteComment(commentId: string): Promise<void> {
    await ensureSchema(this.db);
    await this.db
      .prepare("DELETE FROM comments WHERE id = ?")
      .bind(commentId)
      .run();
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

  // Bound the poll response, mirroring listComments' cap. Submission is
  // unauthenticated on an open instance, so an artifact's queue can be flooded
  // with 12 KiB rows; without a cap the owner's poll would try to load all of
  // them into one JSON response and fall over exactly when the owner needs it
  // to find the spam ids to purge.
  //
  // Unlike comments this keeps the OLDEST window (ASC LIMIT), which is safe
  // here for the reason it is not there: a feedback row leaves the status
  // filter once it is acked or purged, so draining the queue advances the
  // window. Comments are never removed from their list, so an ASC LIMIT would
  // freeze on the first 100 forever.
  //
  // Tie-break on rowid, not id: created_at is only millisecond-precise, so a
  // burst of submissions shares a timestamp, and ids are random (generateId)
  // — ordering by them would shuffle same-millisecond rows and make both
  // "oldest first" and which 100 the cap returns nondeterministic. rowid is
  // SQLite's monotonic insert counter, so it is the real arrival order.
  async listFeedback(
    artifactId: string,
    status?: FeedbackStatus,
  ): Promise<FeedbackRecord[]> {
    await ensureSchema(this.db);
    const stmt =
      status === undefined
        ? this.db.prepare(
            `SELECT * FROM feedback WHERE artifact_id = ?
             ORDER BY created_at ASC, rowid ASC LIMIT ${FEEDBACK_PAGE_LIMIT}`,
          )
        : this.db.prepare(
            `SELECT * FROM feedback WHERE artifact_id = ? AND status = ?
             ORDER BY created_at ASC, rowid ASC LIMIT ${FEEDBACK_PAGE_LIMIT}`,
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

  async deleteFeedback(id: string): Promise<void> {
    await ensureSchema(this.db);
    await this.db.prepare("DELETE FROM feedback WHERE id = ?").bind(id).run();
  }

  // Hand-rolled on D1 rather than the native ratelimit binding, which cannot
  // express this rule: its period is restricted to 10 or 60 seconds, so a
  // 10-minute window is out of reach, and it is documented as per-colo and
  // "intentionally designed to not be used as an accurate accounting system".
  // R5 asks for an authoritative bound, so the cost of counting writes with a
  // write is accepted — one statement beside the row the request already adds.
  async consumeToken(
    key: string,
    rule: RateLimitRule,
    now: number,
  ): Promise<{ allowed: boolean }> {
    await ensureSchema(this.db);
    const seconds = now / 1000;
    // A row idle this long has refilled to capacity however empty it was, so it
    // says nothing a missing row would not. Dropping it keeps the limiter from
    // becoming the unbounded-growth vector it exists to prevent: a client
    // rotating addresses would otherwise mint a permanent row per address.
    const staleBefore = seconds - rule.capacity / rule.refillPerSecond;
    // Refill, spend, and refuse in one statement so two concurrent requests on
    // a key cannot both read the same balance and both pass. An empty bucket
    // fails the DO UPDATE's WHERE, which writes nothing and returns no row —
    // that empty result, not a balance, is the rejection.
    const [, spend] = await this.db.batch<{ tokens: number }>([
      this.db
        .prepare("DELETE FROM rate_limits WHERE updated_at <= ?")
        .bind(staleBefore),
      this.db
        .prepare(
          `INSERT INTO rate_limits (bucket_key, tokens, updated_at)
             VALUES (?1, ?2 - 1, ?3)
           ON CONFLICT(bucket_key) DO UPDATE SET
             tokens = MIN(?2, rate_limits.tokens + (?3 - rate_limits.updated_at) * ?4) - 1,
             updated_at = ?3
           WHERE MIN(?2, rate_limits.tokens + (?3 - rate_limits.updated_at) * ?4) >= 1
           RETURNING tokens`,
        )
        .bind(key, rule.capacity, seconds, rule.refillPerSecond),
    ]);
    return { allowed: spend.results.length > 0 };
  }
}

interface CommentRow {
  id: string;
  artifact_id: string;
  author: string | null;
  body: string;
  anchor: string | null;
  done: number | null;
  created_at: string;
}

function toComment(row: CommentRow): CommentMeta {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    author: row.author,
    body: row.body,
    anchor: row.anchor ? (JSON.parse(row.anchor) as Anchor) : null,
    done: row.done === 1,
    createdAt: row.created_at,
  };
}
