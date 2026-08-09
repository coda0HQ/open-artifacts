import { D1MetadataStore } from "./adapters/cloudflare/d1-metadata-store";
import { D1QuotaLedger } from "./adapters/cloudflare/d1-quota-ledger";
import { R2BlobStore } from "./adapters/cloudflare/r2-blob-store";
import type { OwnershipGrant, Visibility } from "./authorizer";
import { CredentialService } from "./credentials/service";
import type {
  Anchor,
  ArtifactFormat,
  ArtifactMeta,
  CommentInput,
  CommentMeta,
  CreateInput,
  EncryptionParams,
  HandoffCreateInput,
  HandoffMeta,
  UpdateInput,
  VersionMeta,
} from "./domain";
import { contentByteLength } from "./domain";
import { validateSchemaCompatibility } from "./migrations/compatibility";
import { SystemClock } from "./ports/clock";
import { CryptoIdGenerator } from "./ports/id-generator";
import { BlobWriter } from "./publication/blob-writer";
import { fingerprintRequest } from "./publication/idempotency";
import { PublicationService } from "./publication/service";
import {
  DEFAULT_QUOTA_LIMITS,
  type QuotaLease,
  type QuotaLimits,
  QuotaService,
} from "./quota/service";
import type { Telemetry } from "./telemetry";
import { generateId, sha256Hex } from "./tokens";

export {
  CURRENT_SCHEMA_VERSION,
  SchemaCompatibilityError,
} from "./migrations/compatibility";
export { IdempotencyConflictError } from "./publication/idempotency";

export interface ArtifactRecord extends ArtifactMeta {
  tokenHash: string;
  channelHash: string | null;
  ownerId: string;
  orgId: string | null;
  visibility: Visibility;
}

export interface StoredContent {
  body: string;
  encrypted: EncryptionParams | null;
}

export interface PublicationContext {
  actorScope: string;
  idempotencyKey: string;
  operation?: "create" | "update" | "channel" | "checkpoint" | "rollback";
  audit?: {
    action: "checkpoint" | "rollback";
    draftRevision: number | null;
    baseVersion: number;
    selectedVersion: number | null;
    actorId: string;
  };
}

export interface PublicationReceipt {
  version: number;
  publicationId: string;
  replayed: boolean;
}

export type PublicationResult =
  | PublicationReceipt
  | { conflict: true; currentVersion: number; publicationId: string };

export interface PublishedArtifact extends ArtifactRecord {
  publication: PublicationReceipt;
}

export interface ArtifactStore {
  create(
    id: string,
    tokenHash: string,
    input: CreateInput,
    channelHash: string | null,
    ownership?: OwnershipGrant | null,
    publication?: PublicationContext,
  ): Promise<PublishedArtifact>;
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
    publication?: PublicationContext,
  ): Promise<PublicationResult>;
  replaceCurrent(
    record: ArtifactRecord,
    input: UpdateInput,
    publication?: PublicationContext,
  ): Promise<PublicationResult>;
  isWriteCredentialAuthorized?(
    record: ArtifactRecord,
    tokenHash: string,
  ): Promise<boolean>;
  delete(id: string): Promise<void>;
  updateVisibility(id: string, visibility: Visibility): Promise<void>;
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

  // Handoff recordings (webcam+mic + interaction events) for an artifact. Media
  // + events live in R2 under handoff/<artifactId>/<handoffId>/{media,events};
  // only metadata is in D1. createHandoff owns the R2 puts + D1 insert together
  // so an orphaned R2 object never survives a failed D1 write. deleteHandoff
  // returns false if the row does not exist (the route 404s).
  listHandoffs(artifactId: string): Promise<HandoffMeta[]>;
  createHandoff(
    artifactId: string,
    input: HandoffCreateInput,
    media: { body: ReadableStream | string | ArrayBuffer | Blob; size: number },
    events: { json: string; size: number },
    deleteTokenHash: string | null,
  ): Promise<HandoffMeta>;
  getHandoff(
    artifactId: string,
    handoffId: string,
  ): Promise<HandoffMeta | null>;
  getHandoffAuth(
    artifactId: string,
    handoffId: string,
  ): Promise<{ deleteTokenHash: string | null } | null>;
  getHandoffMedia(
    artifactId: string,
    handoffId: string,
  ): Promise<{ body: ReadableStream; mediaType: string } | null>;
  getHandoffEvents(
    artifactId: string,
    handoffId: string,
  ): Promise<string | null>;
  deleteHandoff(artifactId: string, handoffId: string): Promise<void>;
}

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS schema_meta (
    singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
    version INTEGER NOT NULL,
    updated_at TEXT NOT NULL
  )`,
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
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    owner_id TEXT NOT NULL DEFAULT '',
    org_id TEXT,
    visibility TEXT NOT NULL DEFAULT 'public'
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
    blob_key TEXT,
    content_hash TEXT,
    publication_id TEXT,
    PRIMARY KEY (artifact_id, version)
  )`,
  `CREATE TABLE IF NOT EXISTS publications (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    actor_scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    expected_version INTEGER,
    target_version INTEGER NOT NULL,
    blob_key TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
      state IN ('pending', 'blob_ready', 'committed', 'conflict', 'failed', 'expired')
    ),
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE (actor_scope, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_publications_artifact_state
    ON publications(artifact_id, state, created_at)`,
  `CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'grace', 'revoked')),
    created_at TEXT NOT NULL,
    expires_at TEXT,
    grace_until TEXT,
    revoked_at TEXT,
    replaced_by TEXT,
    actor_id TEXT NOT NULL,
    UNIQUE (artifact_id, token_hash)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_credentials_artifact_status
    ON credentials(artifact_id, status, created_at)`,
  // anchor / delete_token_hash / done must also appear in MIGRATIONS below —
  // SCHEMA alone never upgrades an existing production DB (#33).
  `CREATE TABLE IF NOT EXISTS comments (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    author TEXT,
    body TEXT NOT NULL,
    created_at TEXT NOT NULL,
    anchor TEXT,
    delete_token_hash TEXT,
    done INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_comments_artifact_created
    ON comments(artifact_id, created_at)`,
  // Handoff recordings: a creator's webcam+mic walkthrough of an artifact.
  // media + events are R2 objects under handoff/<artifactId>/<handoffId>/; this
  // table holds only metadata. version pins a recording to the artifact
  // snapshot it was captured against so playback re-serves that frame.
  `CREATE TABLE IF NOT EXISTS handoffs (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    media_size INTEGER NOT NULL,
    events_size INTEGER NOT NULL,
    has_video INTEGER NOT NULL DEFAULT 1,
    has_audio INTEGER NOT NULL DEFAULT 1,
    has_blur INTEGER NOT NULL DEFAULT 0,
    author TEXT,
    delete_token_hash TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_handoffs_artifact_created
    ON handoffs(artifact_id, created_at)`,
  `CREATE TABLE IF NOT EXISTS quota_reservations (
    scope_key TEXT NOT NULL,
    resource TEXT NOT NULL CHECK (
      resource IN (
        'storage_bytes', 'versions', 'comments', 'handoff_bytes',
        'daily_writes', 'live_sessions'
      )
    ),
    entity_key TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount >= 0),
    limit_value INTEGER NOT NULL CHECK (limit_value >= 0),
    status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope_key, resource, entity_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_quota_active
    ON quota_reservations(scope_key, resource, status)`,
  `CREATE TRIGGER IF NOT EXISTS quota_limit_before_insert
   BEFORE INSERT ON quota_reservations
   WHEN NEW.status IN ('reserved', 'committed') AND (
     SELECT COALESCE(SUM(amount), 0)
     FROM quota_reservations
     WHERE scope_key = NEW.scope_key
       AND resource = NEW.resource
       AND status IN ('reserved', 'committed')
   ) + NEW.amount > NEW.limit_value
   BEGIN
     SELECT RAISE(ABORT, 'QUOTA_EXCEEDED');
   END`,
  `CREATE TRIGGER IF NOT EXISTS quota_limit_before_update
   BEFORE UPDATE OF amount, limit_value, status ON quota_reservations
   WHEN NEW.status IN ('reserved', 'committed') AND (
     SELECT COALESCE(SUM(amount), 0)
     FROM quota_reservations
     WHERE scope_key = NEW.scope_key
       AND resource = NEW.resource
       AND status IN ('reserved', 'committed')
       AND NOT (
         scope_key = OLD.scope_key
         AND resource = OLD.resource
         AND entity_key = OLD.entity_key
       )
   ) + NEW.amount > NEW.limit_value
   BEGIN
     SELECT RAISE(ABORT, 'QUOTA_EXCEEDED');
   END`,
  `CREATE TABLE IF NOT EXISTS live_draft_index (
    artifact_id TEXT PRIMARY KEY,
    protocol_version INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    base_version INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (
      state IN ('active', 'checkpointed', 'conflict', 'expired')
    ),
    actor_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    checkpoint_version INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_live_draft_state_expiry
    ON live_draft_index(state, expires_at)`,
  `CREATE TABLE IF NOT EXISTS live_checkpoint_audit (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('checkpoint', 'rollback')),
    draft_revision INTEGER,
    base_version INTEGER NOT NULL,
    selected_version INTEGER,
    published_version INTEGER NOT NULL,
    publication_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_live_checkpoint_artifact
    ON live_checkpoint_audit(artifact_id, created_at)`,
];

// Convention (#33): SCHEMA is the full current shape for fresh DBs; MIGRATIONS
// upgrades existing DBs to catch up. A column added after v1 must appear in
// BOTH — SCHEMA-only never reaches production; MIGRATIONS-only leaves fresh
// installs depending on an ALTER. MIGRATIONS also carries *removals*: when a
// column/table is dropped from SCHEMA, a DROP is appended here so deployed DBs
// shed it (fresh DBs never had it — see the error tolerance below).
//
// Each ADD errors if the column already exists, which is fine — the column is
// there. The unique index makes channel binding race-safe: concurrent first
// publishes to one channel can only mint one artifact (SQLite allows any
// number of NULLs, so channel-less artifacts are unaffected).
const MIGRATIONS = [
  `ALTER TABLE artifacts ADD COLUMN channel_hash TEXT`,
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
  // Feedback channel removed: drop its table/index and the artifacts.project_ref
  // column it fed. IF EXISTS makes the table/index drops idempotent no-ops; the
  // column drop throws "no such column" once gone and on fresh DBs, which the
  // error tolerance treats as expected.
  `DROP INDEX IF EXISTS idx_feedback_artifact_status`,
  `DROP TABLE IF EXISTS feedback`,
  `ALTER TABLE artifacts DROP COLUMN project_ref`,
  `ALTER TABLE artifacts ADD COLUMN owner_id TEXT NOT NULL DEFAULT ''`,
  `ALTER TABLE artifacts ADD COLUMN org_id TEXT`,
  `ALTER TABLE artifacts ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_owner ON artifacts(owner_id)`,
  `CREATE INDEX IF NOT EXISTS idx_artifacts_org ON artifacts(org_id)`,
  // Handoff recordings (new table): idempotent CREATE so an existing DB picks
  // it up on first request; a fresh DB already has it from SCHEMA above.
  `CREATE TABLE IF NOT EXISTS handoffs (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    version INTEGER NOT NULL,
    duration_ms INTEGER NOT NULL,
    media_type TEXT NOT NULL,
    media_size INTEGER NOT NULL,
    events_size INTEGER NOT NULL,
    has_video INTEGER NOT NULL DEFAULT 1,
    has_audio INTEGER NOT NULL DEFAULT 1,
    has_blur INTEGER NOT NULL DEFAULT 0,
    author TEXT,
    delete_token_hash TEXT,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_handoffs_artifact_created
    ON handoffs(artifact_id, created_at)`,
  // has_blur added after the initial handoffs table shipped: existing DBs got
  // the table from the CREATE TABLE IF NOT EXISTS above but without this
  // column. The ALTER is idempotent (duplicate-column error swallowed by
  // isExpectedMigrationError). Fresh DBs already have it from SCHEMA.
  `ALTER TABLE handoffs ADD COLUMN has_blur INTEGER NOT NULL DEFAULT 0`,
  // Per-version handoffs: the id is now scoped by version
  // (h<artifactId>_v<version>) so each version keeps its own recording. Legacy
  // single-handoff rows (h<artifactId>, no _v suffix) are wiped so a stale
  // one-per-artifact row can't shadow the new version-scoped recording for the
  // same version. Idempotent - a second run matches zero rows. R2 media for the
  // wiped rows is NOT swept here (SQL can't touch R2); the artifact-delete
  // prefix sweep handoff/<artifactId>/ covers them when the artifact goes.
  `DELETE FROM handoffs WHERE id NOT LIKE '%\\_v%' ESCAPE '\\'`,
  `ALTER TABLE versions ADD COLUMN blob_key TEXT`,
  `ALTER TABLE versions ADD COLUMN content_hash TEXT`,
  `ALTER TABLE versions ADD COLUMN publication_id TEXT`,
  `UPDATE versions
   SET blob_key = 'content/' || artifact_id || '/' || version
   WHERE blob_key IS NULL`,
  `CREATE TABLE IF NOT EXISTS publications (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    actor_scope TEXT NOT NULL,
    idempotency_key TEXT NOT NULL,
    request_fingerprint TEXT NOT NULL,
    expected_version INTEGER,
    target_version INTEGER NOT NULL,
    blob_key TEXT NOT NULL,
    content_hash TEXT NOT NULL,
    state TEXT NOT NULL CHECK (
      state IN ('pending', 'blob_ready', 'committed', 'conflict', 'failed', 'expired')
    ),
    error_code TEXT,
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    UNIQUE (actor_scope, idempotency_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_publications_artifact_state
    ON publications(artifact_id, state, created_at)`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_versions_publication
    ON versions(publication_id) WHERE publication_id IS NOT NULL`,
  `CREATE TABLE IF NOT EXISTS credentials (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    status TEXT NOT NULL CHECK (status IN ('active', 'grace', 'revoked')),
    created_at TEXT NOT NULL,
    expires_at TEXT,
    grace_until TEXT,
    revoked_at TEXT,
    replaced_by TEXT,
    actor_id TEXT NOT NULL,
    UNIQUE (artifact_id, token_hash)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_credentials_artifact_status
    ON credentials(artifact_id, status, created_at)`,
  `INSERT OR IGNORE INTO credentials (
     id, artifact_id, token_hash, status, created_at, actor_id
   )
   SELECT 'cred_legacy_' || id, id, token_hash, 'active', created_at,
          'migration-v3'
   FROM artifacts`,
  `CREATE TABLE IF NOT EXISTS quota_reservations (
    scope_key TEXT NOT NULL,
    resource TEXT NOT NULL CHECK (
      resource IN (
        'storage_bytes', 'versions', 'comments', 'handoff_bytes',
        'daily_writes', 'live_sessions'
      )
    ),
    entity_key TEXT NOT NULL,
    amount INTEGER NOT NULL CHECK (amount >= 0),
    limit_value INTEGER NOT NULL CHECK (limit_value >= 0),
    status TEXT NOT NULL CHECK (status IN ('reserved', 'committed', 'released')),
    created_at TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (scope_key, resource, entity_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_quota_active
    ON quota_reservations(scope_key, resource, status)`,
  `CREATE TRIGGER IF NOT EXISTS quota_limit_before_insert
   BEFORE INSERT ON quota_reservations
   WHEN NEW.status IN ('reserved', 'committed') AND (
     SELECT COALESCE(SUM(amount), 0)
     FROM quota_reservations
     WHERE scope_key = NEW.scope_key
       AND resource = NEW.resource
       AND status IN ('reserved', 'committed')
   ) + NEW.amount > NEW.limit_value
   BEGIN
     SELECT RAISE(ABORT, 'QUOTA_EXCEEDED');
   END`,
  `CREATE TRIGGER IF NOT EXISTS quota_limit_before_update
   BEFORE UPDATE OF amount, limit_value, status ON quota_reservations
   WHEN NEW.status IN ('reserved', 'committed') AND (
     SELECT COALESCE(SUM(amount), 0)
     FROM quota_reservations
     WHERE scope_key = NEW.scope_key
       AND resource = NEW.resource
       AND status IN ('reserved', 'committed')
       AND NOT (
         scope_key = OLD.scope_key
         AND resource = OLD.resource
         AND entity_key = OLD.entity_key
       )
   ) + NEW.amount > NEW.limit_value
   BEGIN
     SELECT RAISE(ABORT, 'QUOTA_EXCEEDED');
   END`,
  `CREATE TABLE IF NOT EXISTS live_draft_index (
    artifact_id TEXT PRIMARY KEY,
    protocol_version INTEGER NOT NULL,
    revision INTEGER NOT NULL,
    base_version INTEGER NOT NULL,
    state TEXT NOT NULL CHECK (
      state IN ('active', 'checkpointed', 'conflict', 'expired')
    ),
    actor_id TEXT NOT NULL,
    updated_at TEXT NOT NULL,
    expires_at TEXT NOT NULL,
    checkpoint_version INTEGER
  )`,
  `CREATE INDEX IF NOT EXISTS idx_live_draft_state_expiry
    ON live_draft_index(state, expires_at)`,
  `CREATE TABLE IF NOT EXISTS live_checkpoint_audit (
    id TEXT PRIMARY KEY,
    artifact_id TEXT NOT NULL,
    action TEXT NOT NULL CHECK (action IN ('checkpoint', 'rollback')),
    draft_revision INTEGER,
    base_version INTEGER NOT NULL,
    selected_version INTEGER,
    published_version INTEGER NOT NULL,
    publication_id TEXT NOT NULL,
    actor_id TEXT NOT NULL,
    created_at TEXT NOT NULL
  )`,
  `CREATE INDEX IF NOT EXISTS idx_live_checkpoint_artifact
    ON live_checkpoint_audit(artifact_id, created_at)`,
  `INSERT INTO schema_meta (singleton, version, updated_at)
   VALUES (1, 5, CURRENT_TIMESTAMP)
   ON CONFLICT(singleton) DO UPDATE SET
     version = MAX(schema_meta.version, 5),
     updated_at = excluded.updated_at`,
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

// "duplicate column name": an ADD already ran on this database.
// "UNIQUE constraint failed": the index cannot cover legacy duplicate rows.
// "no such column" on a DROP COLUMN: the column is already gone — every re-run
//   after the first, and every fresh DB where SCHEMA never defined it. Scoped
//   to DROP COLUMN by inspecting the statement, so an unrelated "no such
//   column" from a future migration still surfaces instead of being swallowed.
// Anything else is a genuine failure worth surfacing in the logs.
const isExpectedMigrationError = (error: unknown, sql: string): boolean => {
  if (!(error instanceof Error)) return false;
  if (/\bdrop column\b/i.test(sql) && /no such column/.test(error.message)) {
    return true;
  }
  return /duplicate column name|UNIQUE constraint failed/.test(error.message);
};

// Memoized per database so a second binding (or a fresh test database in the
// same isolate) never skips its own setup. A failed attempt clears the memo,
// so a transient D1 error does not poison every subsequent request — including
// unexpected migration/backfill failures (#33), which used to warn-and-continue
// and permanently memoize success for the isolate's life.
const schemaReady = new WeakMap<D1Database, Promise<unknown>>();
const schemaValidated = new WeakMap<D1Database, Promise<unknown>>();

export type SchemaPolicy = "migrate" | "validate";
export interface D1R2StoreOptions {
  schemaPolicy?: SchemaPolicy;
  quotaLimits?: QuotaLimits;
  telemetry?: Telemetry;
}

const schemaPolicies = new WeakMap<D1Database, SchemaPolicy>();

type EnsureSchemaOptions = {
  // Test-only override: run these instead of MIGRATIONS (skips BACKFILL).
  migrations?: readonly string[];
};

async function migrateSchema(
  db: D1Database,
  options?: EnsureSchemaOptions,
): Promise<unknown> {
  const pending = schemaReady.get(db);
  if (pending) return pending;
  const migrations = options?.migrations ?? MIGRATIONS;
  const runBackfill = options?.migrations === undefined;
  const run = async () => {
    await db.batch(SCHEMA.map((sql) => db.prepare(sql)));
    // Statements run via prepare(), not exec(): exec() splits its input on
    // newlines and rejects multi-line statements like BACKFILL. Sequential,
    // not parallel: the unique index depends on the channel_hash ALTER having
    // run first on a pre-channel database. Expected failures (column already
    // added, or an index blocked by legacy duplicate rows) stay silent;
    // anything else rejects so the memo clears and the next request retries.
    for (const sql of migrations) {
      try {
        await db.prepare(sql).run();
      } catch (error) {
        if (!isExpectedMigrationError(error, sql)) {
          console.warn("migration failed:", sql, error);
          throw error;
        }
      }
    }
    // Backfill historical version rows that got empty defaults from the
    // ALTER above. No-op once rows are populated. A real failure must reject
    // so we do not memoize success and skip the backfill forever (#33).
    if (runBackfill) {
      await db.prepare(BACKFILL).run();
    }
  };
  const attempt = run().catch((error) => {
    schemaReady.delete(db);
    throw error;
  });
  schemaReady.set(db, attempt);
  return attempt;
}

async function validateSchema(db: D1Database): Promise<unknown> {
  const pending = schemaValidated.get(db);
  if (pending) return pending;
  const attempt = validateSchemaCompatibility(db).catch((error) => {
    schemaValidated.delete(db);
    throw error;
  });
  schemaValidated.set(db, attempt);
  return attempt;
}

async function ensureSchema(
  db: D1Database,
  options?: EnsureSchemaOptions,
): Promise<unknown> {
  if (options !== undefined || schemaPolicies.get(db) !== "validate") {
    return migrateSchema(db, options);
  }
  return validateSchema(db);
}

/** @internal Test hook — production callers go through D1R2Store. */
export async function ensureSchemaForTests(
  db: D1Database,
  options?: EnsureSchemaOptions,
): Promise<unknown> {
  return migrateSchema(db, options);
}

/** @internal Clears the per-DB schema memo between migration tests. */
export function resetSchemaMemoForTests(db: D1Database): void {
  schemaReady.delete(db);
  schemaValidated.delete(db);
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
  created_at: string;
  updated_at: string;
  owner_id: string;
  org_id: string | null;
  visibility: string;
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
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    ownerId: row.owner_id ?? "",
    orgId: row.org_id ?? null,
    visibility: (row.visibility ?? "public") as Visibility,
  };
}

const defaultOwnership = (): OwnershipGrant => ({
  ownerId: "",
  orgId: null,
  visibility: "public",
});

const contentKey = (id: string, version: number) => `content/${id}/${version}`;
interface VersionStorageRow {
  blob_key: string | null;
  content_hash: string | null;
  publication_id: string | null;
  publication_state: string | null;
}

// Derive a stable, deterministic handoff id from the artifact id + version so
// re-records of the SAME version overwrite the same D1 row + R2 keys in place
// (race-free), while different versions keep independent recordings. The "h"
// prefix keeps the handoff id visually distinct from the artifact id while
// staying in the same URL-safe alphabet; the `_v<N>` suffix scopes the row.
// Two concurrent POSTs for the same artifact+version resolve to the same id
// and the ON CONFLICT DO UPDATE makes the last COMMIT win - no
// list/delete/create window, no orphaned media. Legacy single-handoff rows
// (h<artifactId>, no suffix) are wiped by a MIGRATIONS DELETE on first deploy
// of this change; their R2 media is swept by the artifact-delete prefix sweep.
const handoffIdFor = (artifactId: string, version: number): string =>
  `h${artifactId}_v${version}`;

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
  private readonly publicationMetadata: D1MetadataStore;
  private readonly publicationService: PublicationService;
  private readonly credentialService: CredentialService;
  private readonly quotaService: QuotaService;
  private readonly telemetry?: Telemetry;

  constructor(
    private readonly db: D1Database,
    private readonly bucket: R2Bucket,
    options: D1R2StoreOptions = {},
  ) {
    this.telemetry = options.telemetry;
    schemaPolicies.set(db, options.schemaPolicy ?? "migrate");
    this.publicationMetadata = new D1MetadataStore(db);
    this.publicationService = new PublicationService(
      this.publicationMetadata,
      new BlobWriter(new R2BlobStore(bucket)),
      new SystemClock(),
      new CryptoIdGenerator(),
      this.telemetry,
    );
    this.credentialService = new CredentialService(
      db,
      new SystemClock(),
      new CryptoIdGenerator(),
    );
    this.quotaService = new QuotaService(
      new D1QuotaLedger(db),
      options.quotaLimits ?? { ...DEFAULT_QUOTA_LIMITS },
      new SystemClock(),
    );
  }

  private artifactScope(artifactId: string): string {
    return `artifact:${artifactId}`;
  }

  private dailyScope(actorScope: string, now: string): string {
    return `daily:${actorScope}:${now.slice(0, 10)}`;
  }

  private reservePublicationQuota(input: {
    artifactId: string;
    actorScope: string;
    publicationId: string;
    bytes: number;
    now: string;
  }): Promise<QuotaLease> {
    const entityKey = `publication:${input.publicationId}`;
    return this.quotaService.reserve([
      {
        scopeKey: this.artifactScope(input.artifactId),
        resource: "storage_bytes",
        entityKey,
        amount: input.bytes,
      },
      {
        scopeKey: this.artifactScope(input.artifactId),
        resource: "versions",
        entityKey,
        amount: 1,
      },
      {
        scopeKey: this.dailyScope(input.actorScope, input.now),
        resource: "daily_writes",
        entityKey,
        amount: 1,
      },
    ]);
  }

  private recordD1Commit(
    result: "success" | "failure",
    input: {
      artifactId: string;
      publicationId: string;
      version: number;
      startedAt: number;
      error?: unknown;
    },
  ): void {
    const durationMs = Date.now() - input.startedAt;
    const fields = {
      artifactId: input.artifactId,
      publicationId: input.publicationId,
      version: input.version,
      durationMs,
      ...(input.error === undefined ? {} : { error: input.error }),
    };
    if (result === "success") {
      this.telemetry?.info("storage.d1.commit.succeeded", fields);
    } else {
      this.telemetry?.error("storage.d1.commit.failed", fields);
    }
    if (this.telemetry) {
      this.telemetry.metric("storage_operation", {
        value: 1,
        durationMs,
        route: this.telemetry.context.route,
        operation: "d1",
        result,
      });
    }
  }

  private recordPublicationOutcome(
    operation: NonNullable<PublicationContext["operation"]>,
    result: "success" | "replayed" | "conflict" | "failure",
    input: {
      artifactId: string;
      publicationId: string;
      version: number;
      startedAt: number;
      bytes?: number;
      error?: unknown;
    },
  ): void {
    const durationMs = Date.now() - input.startedAt;
    const fields = {
      artifactId: input.artifactId,
      publicationId: input.publicationId,
      version: input.version,
      operation,
      result,
      durationMs,
      ...(input.error === undefined ? {} : { error: input.error }),
    };
    if (result === "failure") {
      this.telemetry?.error("publication.completed", fields);
    } else if (result === "conflict") {
      this.telemetry?.warn("publication.completed", fields);
    } else {
      this.telemetry?.info("publication.completed", fields);
    }
    if (!this.telemetry) return;
    this.telemetry.metric("publication_operation", {
      value: 1,
      durationMs,
      route: this.telemetry.context.route,
      operation,
      result,
      status: result === "conflict" ? 409 : result === "failure" ? 500 : 200,
    });
    if (result === "conflict" || result === "failure") {
      this.telemetry.metric("publication_state_failure", {
        value: 1,
        durationMs,
        route: this.telemetry.context.route,
        operation,
        result,
        status: result === "conflict" ? 409 : 500,
      });
    }
    if (result === "success" && input.bytes !== undefined) {
      this.telemetry.metric("storage_growth", {
        value: input.bytes,
        route: this.telemetry.context.route,
        operation,
        result: "success",
        status: 200,
      });
    }
  }

  private recordMissingBlob(input: {
    artifactId: string;
    version: number;
    blobKey: string;
    reason: "missing" | "metadata_mismatch" | "hash_mismatch";
  }): void {
    this.telemetry?.error("storage.r2.blob_unreadable", input);
    if (!this.telemetry) return;
    this.telemetry.metric("missing_blob", {
      value: 1,
      route: this.telemetry.context.route,
      operation: "r2",
      result: "missing",
      status: 500,
    });
  }

  async create(
    id: string,
    tokenHash: string,
    input: CreateInput,
    channelHash: string | null,
    ownership: OwnershipGrant | null = null,
    publication?: PublicationContext,
  ): Promise<PublishedArtifact> {
    await ensureSchema(this.db);
    const grant = ownership ?? defaultOwnership();
    const operation = publication?.operation ?? "create";
    const operationStartedAt = Date.now();
    const actorScope = publication?.actorScope ?? `legacy-create:${id}`;
    const idempotencyKey =
      publication?.idempotencyKey ?? `auto:${generateId()}`;
    const objectBody = contentObjectBody(input.content, input.encrypted);
    const contentHash = await sha256Hex(objectBody);
    const requestFingerprint = await fingerprintRequest({
      operation,
      contentHash,
      format: input.format,
      title: input.title,
      description: input.description,
      favicon: input.favicon,
      label: input.label,
      encrypted: input.encrypted,
      channelHash,
      ownerId: grant.ownerId,
      orgId: grant.orgId,
      visibility: grant.visibility,
    });
    const prepared = await this.publicationService.prepare({
      artifactId: id,
      artifactIdMode: "allocate",
      actorScope,
      idempotencyKey,
      requestFingerprint,
      expectedVersion: null,
      targetVersion: 1,
      body: objectBody,
      encrypted: input.encrypted !== null,
    });
    if (prepared.kind === "committed") {
      const existing = await this.get(prepared.publication.artifactId);
      if (existing === null) {
        throw new Error("committed publication references a missing artifact");
      }
      this.recordPublicationOutcome(operation, "replayed", {
        artifactId: existing.id,
        publicationId: prepared.publication.id,
        version: prepared.publication.targetVersion,
        startedAt: operationStartedAt,
      });
      return {
        ...existing,
        publication: {
          version: prepared.publication.targetVersion,
          publicationId: prepared.publication.id,
          replayed: true,
        },
      };
    }
    if (prepared.kind === "conflict") {
      this.recordPublicationOutcome(operation, "conflict", {
        artifactId: prepared.publication.artifactId,
        publicationId: prepared.publication.id,
        version: prepared.publication.targetVersion,
        startedAt: operationStartedAt,
      });
      throw new Error(
        `create publication ${prepared.publication.id} conflicted`,
      );
    }
    const publicationId = prepared.publication.id;
    const credentialId = `cred_${generateId()}`;
    const artifactId = prepared.publication.artifactId;
    const blobKey = prepared.publication.blobKey;
    const now = prepared.publication.createdAt;
    let quotaLease: QuotaLease;
    try {
      quotaLease = await this.reservePublicationQuota({
        artifactId,
        actorScope,
        publicationId,
        bytes: contentByteLength(objectBody),
        now,
      });
    } catch (error) {
      await this.publicationMetadata
        .transitionPublication({
          id: publicationId,
          expectedState: "blob_ready",
          nextState: "failed",
          errorCode: "QUOTA_EXCEEDED",
          updatedAt: now,
        })
        .catch(() => null);
      this.recordPublicationOutcome(operation, "failure", {
        artifactId,
        publicationId,
        version: 1,
        startedAt: operationStartedAt,
        error,
      });
      throw error;
    }

    const commitStartedAt = Date.now();
    const insert = this.db.batch([
      this.db
        .prepare(
          `INSERT INTO artifacts (id, token_hash, channel_hash, title, description, favicon, format, encrypted, current_version, created_at, updated_at, owner_id, org_id, visibility)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?)`,
        )
        .bind(
          artifactId,
          tokenHash,
          channelHash,
          input.title,
          input.description,
          input.favicon,
          input.format,
          input.encrypted ? 1 : 0,
          now,
          now,
          grant.ownerId,
          grant.orgId,
          grant.visibility,
        ),
      this.db
        .prepare(
          `INSERT INTO versions (
             artifact_id, version, label, title, description, favicon,
             format, encrypted, size, created_at, blob_key, content_hash,
             publication_id
           ) VALUES (?, 1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          artifactId,
          input.label,
          input.title,
          input.description,
          input.favicon,
          input.format,
          input.encrypted ? 1 : 0,
          contentByteLength(input.content),
          now,
          blobKey,
          prepared.publication.contentHash,
          publicationId,
        ),
      this.db
        .prepare(
          `UPDATE publications
           SET state = 'committed', error_code = NULL, updated_at = ?
           WHERE id = ? AND state = 'blob_ready'`,
        )
        .bind(now, publicationId),
      this.db
        .prepare(
          `INSERT INTO credentials (
             id, artifact_id, token_hash, status, created_at, actor_id
           ) VALUES (?, ?, ?, 'active', ?, ?)`,
        )
        .bind(
          credentialId,
          artifactId,
          tokenHash,
          now,
          grant.ownerId || "artifact-create",
        ),
    ]);
    // The unique channel index makes a failed insert an expected outcome of
    // racing first publishes. Delete the losing pending row so the channel
    // fallback can reuse the same idempotency key against the winning artifact;
    // its content-addressed blob stays non-visible and is reconciled later.
    try {
      await insert;
    } catch (error) {
      this.recordD1Commit("failure", {
        artifactId,
        publicationId,
        version: 1,
        startedAt: commitStartedAt,
        error,
      });
      const raced =
        await this.publicationMetadata.findPublicationById(publicationId);
      if (raced?.state === "committed") {
        await quotaLease.commit().catch(() => {});
        const existing = await this.get(raced.artifactId);
        if (existing === null) {
          throw new Error(
            "committed publication references a missing artifact",
          );
        }
        this.recordPublicationOutcome(operation, "replayed", {
          artifactId: existing.id,
          publicationId: raced.id,
          version: raced.targetVersion,
          startedAt: operationStartedAt,
        });
        return {
          ...existing,
          publication: {
            version: raced.targetVersion,
            publicationId: raced.id,
            replayed: true,
          },
        };
      }
      if (
        channelHash !== null &&
        error instanceof Error &&
        error.message.includes("channel_hash")
      ) {
        await this.db
          .prepare(
            "DELETE FROM publications WHERE id = ? AND state = 'blob_ready'",
          )
          .bind(publicationId)
          .run()
          .catch(() => {});
      }
      await quotaLease.release().catch(() => {});
      this.recordPublicationOutcome(operation, "failure", {
        artifactId,
        publicationId,
        version: 1,
        startedAt: operationStartedAt,
        error,
      });
      throw error;
    }
    this.recordD1Commit("success", {
      artifactId,
      publicationId,
      version: 1,
      startedAt: commitStartedAt,
    });
    await quotaLease.commit().catch(() => {});
    this.recordPublicationOutcome(operation, "success", {
      artifactId,
      publicationId,
      version: 1,
      startedAt: operationStartedAt,
      bytes: contentByteLength(objectBody),
    });
    return {
      id: artifactId,
      tokenHash,
      channelHash,
      title: input.title,
      description: input.description,
      favicon: input.favicon,
      format: input.format,
      encrypted: input.encrypted !== null,
      currentVersion: 1,
      createdAt: now,
      updatedAt: now,
      ownerId: grant.ownerId,
      orgId: grant.orgId,
      visibility: grant.visibility,
      publication: {
        version: 1,
        publicationId,
        replayed: prepared.replayed,
      },
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
         FROM versions
         WHERE artifact_id = ?
           AND (
             publication_id IS NULL OR EXISTS (
               SELECT 1 FROM publications
               WHERE publications.id = versions.publication_id
                 AND publications.state = 'committed'
             )
           )
         ORDER BY version ASC`,
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
    await ensureSchema(this.db);
    const storage = await this.db
      .prepare(
        `SELECT v.blob_key, v.content_hash, v.publication_id,
                p.state AS publication_state
         FROM versions v
         LEFT JOIN publications p ON p.id = v.publication_id
         WHERE v.artifact_id = ? AND v.version = ?`,
      )
      .bind(id, version)
      .first<VersionStorageRow>();
    if (storage === null) return null;
    if (
      storage.publication_id !== null &&
      storage.publication_state !== "committed"
    ) {
      return null;
    }
    const key = storage.blob_key ?? contentKey(id, version);
    const object = await this.bucket.get(key);
    if (object === null) {
      this.recordMissingBlob({
        artifactId: id,
        version,
        blobKey: key,
        reason: "missing",
      });
      return null;
    }
    const body = await object.text();
    if (storage.content_hash !== null) {
      if (object.customMetadata?.content_hash !== storage.content_hash) {
        this.recordMissingBlob({
          artifactId: id,
          version,
          blobKey: key,
          reason: "metadata_mismatch",
        });
        return null;
      }
      if ((await sha256Hex(body)) !== storage.content_hash) {
        this.recordMissingBlob({
          artifactId: id,
          version,
          blobKey: key,
          reason: "hash_mismatch",
        });
        return null;
      }
    }
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
    await ensureSchema(this.db);
    // head() returns the R2 object's metadata without streaming the body —
    // the authoritative per-version encrypted flag, which the versions-table
    // flag is not on legacy mixed-encryption artifacts.
    const storage = await this.db
      .prepare(
        `SELECT v.blob_key, v.content_hash, v.publication_id,
                p.state AS publication_state
         FROM versions v
         LEFT JOIN publications p ON p.id = v.publication_id
         WHERE v.artifact_id = ? AND v.version = ?`,
      )
      .bind(id, version)
      .first<VersionStorageRow>();
    if (storage === null) return null;
    if (
      storage.publication_id !== null &&
      storage.publication_state !== "committed"
    ) {
      return null;
    }
    const key = storage.blob_key ?? contentKey(id, version);
    const object = await this.bucket.head(key);
    if (object === null) {
      this.recordMissingBlob({
        artifactId: id,
        version,
        blobKey: key,
        reason: "missing",
      });
      return null;
    }
    if (
      storage.content_hash !== null &&
      object.customMetadata?.content_hash !== storage.content_hash
    ) {
      this.recordMissingBlob({
        artifactId: id,
        version,
        blobKey: key,
        reason: "metadata_mismatch",
      });
      return null;
    }
    return { encrypted: object.customMetadata?.encrypted === "1" };
  }

  async update(
    record: ArtifactRecord,
    input: UpdateInput,
    publication?: PublicationContext,
  ): Promise<PublicationResult> {
    await ensureSchema(this.db);
    const now = new Date().toISOString();
    const encrypted = input.encrypted !== null;
    const vTitle = input.title ?? record.title;
    const vDescription = input.description ?? record.description;
    const vFavicon = input.favicon ?? record.favicon;
    const vFormat = input.format ?? record.format;

    const objectBody = contentObjectBody(input.content, input.encrypted);
    const contentHash = await sha256Hex(objectBody);
    const actorScope = publication?.actorScope ?? `legacy:${record.id}`;
    const idempotencyKey =
      publication?.idempotencyKey ?? `auto:${generateId()}`;
    const operation = publication?.operation ?? "update";
    const operationStartedAt = Date.now();
    const fingerprintPayload =
      operation === "channel"
        ? {
            operation,
            contentHash,
            format: vFormat,
            title: vTitle,
            description: vDescription,
            favicon: vFavicon,
            label: input.label,
            encrypted: input.encrypted,
            channelHash: record.channelHash,
            ownerId: record.ownerId,
            orgId: record.orgId,
            visibility: record.visibility,
          }
        : {
            operation,
            artifactId: record.id,
            contentHash,
            format: input.format,
            title: input.title,
            description: input.description,
            favicon: input.favicon,
            label: input.label,
            encrypted: input.encrypted,
            baseVersion: input.baseVersion,
            force: input.force,
          };
    const requestFingerprint = await fingerprintRequest(fingerprintPayload);
    const prepared = await this.publicationService.prepare({
      artifactId: record.id,
      actorScope,
      idempotencyKey,
      requestFingerprint,
      expectedVersion: record.currentVersion,
      targetVersion: record.currentVersion + 1,
      body: objectBody,
      encrypted,
      requestedBaseVersion: input.baseVersion,
      force: input.force,
    });
    if (prepared.kind === "committed") {
      this.recordPublicationOutcome(operation, "replayed", {
        artifactId: record.id,
        publicationId: prepared.publication.id,
        version: prepared.publication.targetVersion,
        startedAt: operationStartedAt,
      });
      return {
        version: prepared.publication.targetVersion,
        publicationId: prepared.publication.id,
        replayed: true,
      };
    }
    if (prepared.kind === "conflict") {
      const fresh = await this.get(record.id);
      this.recordPublicationOutcome(operation, "conflict", {
        artifactId: record.id,
        publicationId: prepared.publication.id,
        version: prepared.publication.targetVersion,
        startedAt: operationStartedAt,
      });
      return {
        conflict: true,
        currentVersion: fresh?.currentVersion ?? record.currentVersion,
        publicationId: prepared.publication.id,
      };
    }
    const publicationId = prepared.publication.id;
    const version = prepared.publication.targetVersion;
    const expectedVersion =
      prepared.publication.expectedVersion ?? record.currentVersion;
    const blobKey = prepared.publication.blobKey;
    let quotaLease: QuotaLease;
    try {
      quotaLease = await this.reservePublicationQuota({
        artifactId: record.id,
        actorScope,
        publicationId,
        bytes: contentByteLength(objectBody),
        now,
      });
    } catch (error) {
      await this.publicationMetadata
        .transitionPublication({
          id: publicationId,
          expectedState: "blob_ready",
          nextState: "failed",
          errorCode: "QUOTA_EXCEEDED",
          updatedAt: now,
        })
        .catch(() => null);
      this.recordPublicationOutcome(operation, "failure", {
        artifactId: record.id,
        publicationId,
        version: prepared.publication.targetVersion,
        startedAt: operationStartedAt,
        error,
      });
      throw error;
    }

    const commitStatements: D1PreparedStatement[] = [
      this.db
        .prepare(
          `INSERT INTO versions (
             artifact_id, version, label, title, description, favicon,
             format, encrypted, size, created_at, blob_key, content_hash,
             publication_id
           )
           SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
           WHERE EXISTS (
             SELECT 1 FROM artifacts WHERE id = ? AND current_version = ?
           )`,
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
          blobKey,
          prepared.publication.contentHash,
          publicationId,
          record.id,
          expectedVersion,
        ),
      this.db
        .prepare(
          `UPDATE artifacts
           SET title = ?, description = ?, favicon = ?, format = ?,
               encrypted = ?, current_version = ?, updated_at = ?
           WHERE id = ? AND current_version = ?`,
        )
        .bind(
          vTitle,
          vDescription,
          vFavicon,
          vFormat,
          input.encrypted ? 1 : 0,
          version,
          now,
          record.id,
          expectedVersion,
        ),
      this.db
        .prepare(
          `UPDATE publications
           SET state = CASE
             WHEN EXISTS (
               SELECT 1 FROM versions
               WHERE publication_id = ? AND artifact_id = ? AND version = ?
             ) THEN 'committed'
             ELSE 'conflict'
           END,
           error_code = CASE
             WHEN EXISTS (SELECT 1 FROM versions WHERE publication_id = ?)
               THEN NULL
             ELSE 'VERSION_CONFLICT'
           END,
           updated_at = ?
           WHERE id = ? AND state = 'blob_ready'`,
        )
        .bind(
          publicationId,
          record.id,
          version,
          publicationId,
          now,
          publicationId,
        ),
    ];
    if (publication?.audit) {
      commitStatements.push(
        this.db
          .prepare(
            `INSERT INTO live_checkpoint_audit (
               id, artifact_id, action, draft_revision, base_version,
               selected_version, published_version, publication_id,
               actor_id, created_at
             )
             SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
             WHERE EXISTS (
               SELECT 1 FROM versions WHERE publication_id = ?
             )`,
          )
          .bind(
            `audit_${publicationId}`,
            record.id,
            publication.audit.action,
            publication.audit.draftRevision,
            publication.audit.baseVersion,
            publication.audit.selectedVersion,
            version,
            publicationId,
            publication.audit.actorId,
            now,
            publicationId,
          ),
      );
    }
    let committed: D1Result[];
    const commitStartedAt = Date.now();
    try {
      committed = await this.db.batch(commitStatements);
    } catch (error) {
      this.recordD1Commit("failure", {
        artifactId: record.id,
        publicationId,
        version,
        startedAt: commitStartedAt,
        error,
      });
      await quotaLease.release().catch(() => {});
      throw error;
    }
    this.recordD1Commit("success", {
      artifactId: record.id,
      publicationId,
      version,
      startedAt: commitStartedAt,
    });

    if ((committed[1].meta.changes ?? 0) === 0) {
      const raced =
        await this.publicationMetadata.findPublicationById(publicationId);
      if (raced?.state === "committed") {
        await quotaLease.commit().catch(() => {});
        this.recordPublicationOutcome(operation, "replayed", {
          artifactId: record.id,
          publicationId,
          version,
          startedAt: operationStartedAt,
        });
        return { version, publicationId, replayed: true };
      }
      await quotaLease.release().catch(() => {});
      const fresh = await this.get(record.id);
      this.recordPublicationOutcome(operation, "conflict", {
        artifactId: record.id,
        publicationId,
        version,
        startedAt: operationStartedAt,
      });
      return {
        conflict: true,
        currentVersion: fresh?.currentVersion ?? expectedVersion,
        publicationId,
      };
    }

    await quotaLease.commit().catch(() => {});
    this.recordPublicationOutcome(
      operation,
      prepared.replayed ? "replayed" : "success",
      {
        artifactId: record.id,
        publicationId,
        version,
        startedAt: operationStartedAt,
        bytes: contentByteLength(objectBody),
      },
    );
    return { version, publicationId, replayed: prepared.replayed };
  }

  async replaceCurrent(
    record: ArtifactRecord,
    input: UpdateInput,
    publication?: PublicationContext,
  ): Promise<PublicationResult> {
    // Compatibility facade for older Live clients. Published history is now
    // immutable: a Live save is a checkpoint through the same atomic
    // publication path as a normal update.
    return this.update(record, input, publication);
  }

  async isWriteCredentialAuthorized(
    record: ArtifactRecord,
    tokenHash: string,
  ): Promise<boolean> {
    await ensureSchema(this.db);
    return this.credentialService.isAuthorized(
      record.id,
      tokenHash,
      record.tokenHash,
    );
  }

  async delete(id: string): Promise<void> {
    await ensureSchema(this.db);
    // list() returns at most 1000 keys per page (delete() accepts at most as
    // many), so drain page by page — an artifact republished from a channel
    // can easily accumulate more versions than one page holds. The same drain
    // sweeps handoff media+events (handoff/<id>/) alongside content/<id>/.
    for (const prefix of [`content/${id}/`, `handoff/${id}/`]) {
      for (;;) {
        const page = await this.bucket.list({ prefix });
        if (page.objects.length > 0) {
          await this.bucket.delete(page.objects.map((o) => o.key));
        }
        if (!page.truncated) break;
      }
    }
    await this.db.batch([
      this.db.prepare("DELETE FROM credentials WHERE artifact_id = ?").bind(id),
      this.db.prepare("DELETE FROM versions WHERE artifact_id = ?").bind(id),
      this.db
        .prepare("DELETE FROM publications WHERE artifact_id = ?")
        .bind(id),
      this.db.prepare("DELETE FROM artifacts WHERE id = ?").bind(id),
      this.db.prepare("DELETE FROM comments WHERE artifact_id = ?").bind(id),
      this.db.prepare("DELETE FROM handoffs WHERE artifact_id = ?").bind(id),
      this.db
        .prepare("DELETE FROM live_draft_index WHERE artifact_id = ?")
        .bind(id),
      this.db
        .prepare("DELETE FROM live_checkpoint_audit WHERE artifact_id = ?")
        .bind(id),
    ]);
    await this.quotaService.releaseScope(this.artifactScope(id));
  }

  async updateVisibility(id: string, visibility: Visibility): Promise<void> {
    await ensureSchema(this.db);
    const now = new Date().toISOString();
    await this.db
      .prepare(
        "UPDATE artifacts SET visibility = ?, updated_at = ? WHERE id = ?",
      )
      .bind(visibility, now, id)
      .run();
  }

  async listComments(artifactId: string): Promise<CommentMeta[]> {
    await ensureSchema(this.db);
    // Cap at 100 to bound inlined HTML. Keep the *newest* window (DESC LIMIT),
    // then reverse so callers still see chronological oldest-first. ASC LIMIT
    // would freeze on the first 100 and hide every subsequent post.
    //
    // Tie-break on rowid, not id: created_at is only millisecond-precise, so a
    // same-millisecond burst ties on it, and id is random — which would make
    // both the order and which 100 survive the cap nondeterministic. rowid is
    // monotonic with insertion. Same fix the feedback poll took (#22).
    const { results } = await this.db
      .prepare(
        `SELECT id, artifact_id, author, body, anchor, done, created_at
         FROM comments WHERE artifact_id = ?
         ORDER BY created_at DESC, rowid DESC LIMIT 100`,
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
    const quotaLease = await this.quotaService.reserve([
      {
        scopeKey: this.artifactScope(artifactId),
        resource: "comments",
        entityKey: `comment:${id}`,
        amount: 1,
      },
      {
        scopeKey: this.dailyScope(`comment:${artifactId}`, now),
        resource: "daily_writes",
        entityKey: `comment:${id}`,
        amount: 1,
      },
    ]);
    try {
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
    } catch (error) {
      await quotaLease.release().catch(() => {});
      throw error;
    }
    await quotaLease.commit().catch(() => {});
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
    const comment = await this.getComment(commentId);
    await this.db
      .prepare("DELETE FROM comments WHERE id = ?")
      .bind(commentId)
      .run();
    if (comment) {
      await this.quotaService.releaseEntity(
        this.artifactScope(comment.artifactId),
        "comments",
        `comment:${commentId}`,
      );
    }
  }

  // --- Handoff recordings (webcam+mic media + interaction events in R2) ---

  async listHandoffs(artifactId: string): Promise<HandoffMeta[]> {
    await ensureSchema(this.db);
    const { results } = await this.db
      .prepare(
        `SELECT id, artifact_id, version, duration_ms, media_type, media_size, events_size, has_video, has_audio, has_blur, author, created_at
         FROM handoffs WHERE artifact_id = ? ORDER BY created_at DESC LIMIT 100`,
      )
      .bind(artifactId)
      .all<HandoffRow>();
    return results.map(toHandoff);
  }

  async createHandoff(
    artifactId: string,
    input: HandoffCreateInput,
    media: { body: ReadableStream | string | ArrayBuffer | Blob; size: number },
    events: { json: string; size: number },
    deleteTokenHash: string | null,
  ): Promise<HandoffMeta> {
    await ensureSchema(this.db);
    // One handoff per artifact+version: derive a stable id from the
    // artifactId + version so a re-record of the same version UPSERTs the
    // same D1 row and overwrites the same R2 keys in place - no
    // list/delete/create window, no race, no orphaned media under a
    // discarded id. Concurrent POSTs for the same version converge on the
    // same id and the last COMMIT wins (INSERT ... ON CONFLICT DO UPDATE),
    // exactly one row survives. Different versions get distinct ids, so
    // their recordings coexist independently.
    const id = handoffIdFor(artifactId, input.version);
    const now = new Date().toISOString();
    const mediaKey = `handoff/${artifactId}/${id}/media`;
    const eventsKey = `handoff/${artifactId}/${id}/events`;
    const quotaLease = await this.quotaService.reserve([
      {
        scopeKey: this.artifactScope(artifactId),
        resource: "handoff_bytes",
        entityKey: `handoff:${id}`,
        amount: media.size + events.size,
      },
      {
        scopeKey: this.dailyScope(`handoff:${artifactId}`, now),
        resource: "daily_writes",
        entityKey: `handoff:${id}:${generateId()}`,
        amount: 1,
      },
    ]);
    // Write R2 (media + events) then D1. Any failure across the three writes
    // sweeps both R2 objects so a partial write (e.g. media put succeeds, events
    // put fails) never orphans the media under a D1-less id - the create()
    // channel-conflict cleanup pattern, extended to two objects. customMetadata
    // carries the media type so a direct R2 fetch still knows it without a join.
    try {
      await this.bucket.put(mediaKey, media.body, {
        customMetadata: {
          media_type: input.mediaType,
          artifact_id: artifactId,
        },
      });
      await this.bucket.put(eventsKey, events.json, {
        customMetadata: { artifact_id: artifactId },
      });
      await this.db
        .prepare(
          `INSERT INTO handoffs (id, artifact_id, version, duration_ms, media_type, media_size, events_size, has_video, has_audio, has_blur, author, delete_token_hash, created_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
           ON CONFLICT(id) DO UPDATE SET
             version = excluded.version,
             duration_ms = excluded.duration_ms,
             media_type = excluded.media_type,
             media_size = excluded.media_size,
             events_size = excluded.events_size,
             has_video = excluded.has_video,
             has_audio = excluded.has_audio,
             has_blur = excluded.has_blur,
             author = excluded.author,
             delete_token_hash = excluded.delete_token_hash,
             created_at = excluded.created_at`,
        )
        .bind(
          id,
          artifactId,
          input.version,
          input.durationMs,
          input.mediaType,
          media.size,
          events.size,
          input.hasVideo ? 1 : 0,
          input.hasAudio ? 1 : 0,
          input.hasBlur ? 1 : 0,
          input.author,
          deleteTokenHash,
          now,
        )
        .run();
    } catch (error) {
      await this.bucket.delete([mediaKey, eventsKey]).catch(() => {});
      await quotaLease.release().catch(() => {});
      throw error;
    }
    await quotaLease.commit().catch(() => {});
    return {
      id,
      artifactId,
      version: input.version,
      durationMs: input.durationMs,
      mediaType: input.mediaType,
      mediaSize: media.size,
      eventsSize: events.size,
      hasVideo: input.hasVideo,
      hasAudio: input.hasAudio,
      hasBlur: input.hasBlur,
      author: input.author,
      createdAt: now,
    };
  }

  async getHandoff(
    artifactId: string,
    handoffId: string,
  ): Promise<HandoffMeta | null> {
    await ensureSchema(this.db);
    const row = await this.db
      .prepare(
        "SELECT id, artifact_id, version, duration_ms, media_type, media_size, events_size, has_video, has_audio, has_blur, author, created_at FROM handoffs WHERE id = ? AND artifact_id = ?",
      )
      .bind(handoffId, artifactId)
      .first<HandoffRow>();
    return row ? toHandoff(row) : null;
  }

  // delete_token_hash is server-only (never part of HandoffMeta), mirroring the
  // comment delete-token idiom: the route reads it to authorize a delete.
  async getHandoffAuth(
    artifactId: string,
    handoffId: string,
  ): Promise<{ deleteTokenHash: string | null } | null> {
    await ensureSchema(this.db);
    const row = await this.db
      .prepare(
        "SELECT delete_token_hash FROM handoffs WHERE id = ? AND artifact_id = ?",
      )
      .bind(handoffId, artifactId)
      .first<{ delete_token_hash: string | null }>();
    return row ? { deleteTokenHash: row.delete_token_hash } : null;
  }

  async getHandoffMedia(
    artifactId: string,
    handoffId: string,
  ): Promise<{ body: ReadableStream; mediaType: string } | null> {
    const meta = await this.getHandoff(artifactId, handoffId);
    if (meta === null) return null;
    const object = await this.bucket.get(
      `handoff/${artifactId}/${handoffId}/media`,
    );
    if (object === null) return null;
    return { body: object.body, mediaType: meta.mediaType };
  }

  async getHandoffEvents(
    artifactId: string,
    handoffId: string,
  ): Promise<string | null> {
    // Symmetric with getHandoffMedia: a deleted-but-not-swept events object
    // must never be served for a handoff whose D1 row is gone.
    const meta = await this.getHandoff(artifactId, handoffId);
    if (meta === null) return null;
    const object = await this.bucket.get(
      `handoff/${artifactId}/${handoffId}/events`,
    );
    if (object === null) return null;
    return object.text();
  }

  async deleteHandoff(artifactId: string, handoffId: string): Promise<void> {
    await ensureSchema(this.db);
    await this.bucket.delete([
      `handoff/${artifactId}/${handoffId}/media`,
      `handoff/${artifactId}/${handoffId}/events`,
    ]);
    await this.db
      .prepare("DELETE FROM handoffs WHERE id = ? AND artifact_id = ?")
      .bind(handoffId, artifactId)
      .run();
    await this.quotaService.releaseEntity(
      this.artifactScope(artifactId),
      "handoff_bytes",
      `handoff:${handoffId}`,
    );
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

interface HandoffRow {
  id: string;
  artifact_id: string;
  version: number;
  duration_ms: number;
  media_type: string;
  media_size: number;
  events_size: number;
  has_video: number;
  has_audio: number;
  has_blur: number;
  author: string | null;
  created_at: string;
}

function toHandoff(row: HandoffRow): HandoffMeta {
  return {
    id: row.id,
    artifactId: row.artifact_id,
    version: row.version,
    durationMs: row.duration_ms,
    mediaType: row.media_type,
    mediaSize: row.media_size,
    eventsSize: row.events_size,
    hasVideo: row.has_video === 1,
    hasAudio: row.has_audio === 1,
    hasBlur: row.has_blur === 1,
    author: row.author,
    createdAt: row.created_at,
  };
}
