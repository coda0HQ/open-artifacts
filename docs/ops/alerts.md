# Alert policy

`config/observability/alerts.json` is the reviewed, machine-readable catalog. The alert provisioner maps its metric names to the bounded Analytics Engine schema documented in `dashboards.md`; arbitrary labels are rejected. Evaluation runs every 60 seconds, notifications are deduplicated by alert ID and environment, and recovery requires two healthy windows.

| Alert | Severity | Why this threshold | Primary response |
| --- | --- | --- | --- |
| Missing Blob | P0 | One committed unreadable object violates the zero-missing-content SLO | Freeze writes/GC and follow Missing Blob runbook |
| Publication failure rate | P0 | Two consecutive windows of five failures exceed the publish budget without paging on a singleton | Keep old committed Latest and reconcile |
| Repeated auth failure | P1 | Sustained volume separates probing/broken clients from ordinary typos | Review hashed scope, revoke/rotate if needed |
| Migration incompatible | P0 | A single event means the app cannot safely serve the database | Fail closed; roll forward or schema-compatible rollback |
| Quota exhaustion | P1 | Ten durable rejects indicate abuse or a capacity mismatch | Preserve exact limit; investigate growth |
| Rate saturation | P1 | One hundred burst rejects indicate attack/runaway traffic | Disable anonymous surfaces and contain scope |
| Live failure rate | P1 | Ten failures in ten minutes exceed normal CAS conflicts | Disable Live only; preserve Drafts and normal publish |
| Telemetry silence | P0 | Ten minutes without telemetry can conceal every other incident | Verify serving traffic, binding, logs, and synthetic probes |

P0 pages Platform/SRE immediately and opens an incident. P1 pages the named specialist during supported hours and escalates to P0 if reads, immutable history, or authorization fail. Threshold changes require an owner, rationale, expiry for temporary overrides, and a staging synthetic-event test.
