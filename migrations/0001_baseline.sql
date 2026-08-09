-- Audited upstream baseline at a03a8c3721dd0021c78ea24533d6f7a7f4af07b3.
-- Existing installations must run the baseline-adoption validation before
-- marking this migration applied; fresh databases can execute it directly.

CREATE TABLE IF NOT EXISTS schema_meta (
  singleton INTEGER PRIMARY KEY CHECK (singleton = 1),
  version INTEGER NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS artifacts (
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
);

CREATE UNIQUE INDEX IF NOT EXISTS idx_artifacts_channel_hash
  ON artifacts(channel_hash);
CREATE INDEX IF NOT EXISTS idx_artifacts_owner ON artifacts(owner_id);
CREATE INDEX IF NOT EXISTS idx_artifacts_org ON artifacts(org_id);

CREATE TABLE IF NOT EXISTS versions (
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
);

CREATE TABLE IF NOT EXISTS comments (
  id TEXT PRIMARY KEY,
  artifact_id TEXT NOT NULL,
  author TEXT,
  body TEXT NOT NULL,
  created_at TEXT NOT NULL,
  anchor TEXT,
  delete_token_hash TEXT,
  done INTEGER NOT NULL DEFAULT 0
);

CREATE INDEX IF NOT EXISTS idx_comments_artifact_created
  ON comments(artifact_id, created_at);

CREATE TABLE IF NOT EXISTS handoffs (
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
);

CREATE INDEX IF NOT EXISTS idx_handoffs_artifact_created
  ON handoffs(artifact_id, created_at);

INSERT INTO schema_meta (singleton, version, updated_at)
VALUES (1, 1, CURRENT_TIMESTAMP)
ON CONFLICT(singleton) DO UPDATE SET
  version = MAX(schema_meta.version, 1),
  updated_at = excluded.updated_at;
