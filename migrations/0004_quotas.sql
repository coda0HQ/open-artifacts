-- Exact resource reservations. SQLite triggers serialize checks with writes,
-- while the separate RateLimiter remains an intentionally soft flood gate.

CREATE TABLE quota_reservations (
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
);

CREATE INDEX idx_quota_active
  ON quota_reservations(scope_key, resource, status);

CREATE TRIGGER quota_limit_before_insert
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
END;

CREATE TRIGGER quota_limit_before_update
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
END;

UPDATE schema_meta
SET version = 4, updated_at = CURRENT_TIMESTAMP
WHERE singleton = 1;
