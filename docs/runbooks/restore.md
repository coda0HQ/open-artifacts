# D1 Backup and Isolated Restore

Owner: SRE on-call. Production restore requires Release Manager and data owner approval.

Cloudflare D1 Time Travel is the short-window recovery layer; the scheduled workflow also exports every 24 hours, encrypts with AES-256-GCM, uploads to a separate account/bucket, downloads the object, and verifies SHA-256. The manifest records the Time Travel bookmark, schema, row counts, sampled immutable hashes, retention expiry, and source IDs. Raw encryption keys and upload credentials exist only in the secret manager.

## Daily backup validation

1. Confirm `.github/workflows/backup.yml` completed within 24 hours and produced a receipt plus manifest.
2. Confirm source and destination account IDs differ, the object lives under the environment/year/month prefix, and the independent bucket lifecycle deletes it after the manifest's 90-day expiry.
3. Confirm the post-upload download checksum passed. Never upload the plaintext SQL or encrypted payload as a GitHub Actions artifact.
4. Record the current D1 Time Travel bookmark. A bookmark is not a long-term export and does not replace the independent copy.

## Restore drill

Provision a new D1 database and a restore-only Worker/R2 binding. Never select the production database or its ID. Obtain the encrypted payload, its matching manifest, and the named key version through audited channels, then run:

```sh
node scripts/restore-staging.mjs \
  --manifest /secure/input/backup.manifest.json \
  --payload /secure/input/backup.sql.enc \
  --target-environment restore-drill \
  --target-database open-artifacts-restore-drill \
  --target-database-id <new-isolated-database-id> \
  --config wrangler.staging.jsonc \
  --base-url https://restore-drill.example.invalid \
  --confirm <new-isolated-database-id> \
  --audit-output restore-audit.json
```

The script authenticates/decrypts into a mode-0600 temporary file, imports it, deletes the plaintext, and compares schema version, table row counts, and sampled content hashes. It then reads a sampled immutable version and proves an unauthenticated write fails closed. It refuses `production`, unknown environments, a source database ID, or mismatched confirmation.

## Incident recovery

Prefer restoring or importing into a new database, validating, then switching the Worker binding in a reviewed deployment. In-place Time Travel overwrite cancels queries and is allowed only when new-database recovery cannot meet RTO, after recording the current bookmark so the restore can be undone. After any recovery, run storage reconciliation, verify every committed Blob hash, rotate credentials if exposure is possible, and observe error/missing-content metrics for 30 minutes.

Target RPO is 24 hours and target RTO is 4 hours. The audit's `startedAt`, `finishedAt`, and `durationMs` are the measurement; a runbook checkbox is not evidence.
