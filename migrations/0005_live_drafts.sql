-- Searchable Live draft metadata and immutable checkpoint/rollback audit.
-- Draft payload bytes remain in per-artifact Durable Object SQLite.

CREATE TABLE live_draft_index (
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
);

CREATE INDEX idx_live_draft_state_expiry
  ON live_draft_index(state, expires_at);

CREATE TABLE live_checkpoint_audit (
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
);

CREATE INDEX idx_live_checkpoint_artifact
  ON live_checkpoint_audit(artifact_id, created_at);

UPDATE schema_meta
SET version = 5, updated_at = CURRENT_TIMESTAMP
WHERE singleton = 1;
