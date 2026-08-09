-- Hashed write-token lifecycle. Raw tokens are returned once and never stored.

CREATE TABLE credentials (
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
);

CREATE INDEX idx_credentials_artifact_status
  ON credentials(artifact_id, status, created_at);

INSERT OR IGNORE INTO credentials (
  id, artifact_id, token_hash, status, created_at, actor_id
)
SELECT
  'cred_legacy_' || id,
  id,
  token_hash,
  'active',
  created_at,
  'migration-v3'
FROM artifacts;

UPDATE schema_meta
SET version = 3, updated_at = CURRENT_TIMESTAMP
WHERE singleton = 1;
