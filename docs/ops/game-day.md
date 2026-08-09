# Operations Game Day

This is the repeatable exercise, not a claim that a remote production drill occurred. A non-author operator records their name, environment, immutable commit, resource IDs, start/end times, query links, repair/restore receipts, and reviewer in the release rehearsal record.

## Scenarios

1. Inject an R2 write failure before D1 commit and prove Latest remains the prior readable version; correlate API, R2, and D1 events by request/publication ID.
2. Remove a disposable staging Blob, observe `missing-blob`, freeze writes, dry-run `repair-storage.mjs`, restore the exact hash, and clear the alert.
3. Submit repeated invalid credentials, observe bounded `auth_failure`/`rate_limited` metrics, disable anonymous writes, and verify legitimate reads remain available.
4. Start with an incompatible schema, verify readiness fails closed, then apply the migration runbook.
5. Interrupt repair after a page, inspect checkpoint/audit, resume, and repeat the completed run without mutation.
6. Restore the latest encrypted backup into a newly provisioned staging database; validate schema/rows/hashes/read/auth and record RPO/RTO.
7. Restart/reconnect Live, checkpoint, force a stale-base conflict, disable Live without deleting the namespace, and prove published history remains immutable.
8. Exercise application rollback and roll-forward without crossing a migration or Durable Object lifecycle boundary.

The exercise fails if any raw secret/content reaches logs, production resources are selected, a check is replaced with a screenshot alone, or the operator needs undocumented author knowledge.
