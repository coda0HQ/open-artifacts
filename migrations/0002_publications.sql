-- Publication state and immutable blob references.

ALTER TABLE versions ADD COLUMN blob_key TEXT;
ALTER TABLE versions ADD COLUMN content_hash TEXT;
ALTER TABLE versions ADD COLUMN publication_id TEXT;

UPDATE versions
SET blob_key = 'content/' || artifact_id || '/' || version
WHERE blob_key IS NULL;

CREATE TABLE publications (
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
);

CREATE INDEX idx_publications_artifact_state
  ON publications(artifact_id, state, created_at);
CREATE UNIQUE INDEX idx_versions_publication
  ON versions(publication_id)
  WHERE publication_id IS NOT NULL;

UPDATE schema_meta
SET version = 2, updated_at = CURRENT_TIMESTAMP
WHERE singleton = 1;
