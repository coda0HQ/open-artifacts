# Release rehearsal

The rehearsal has two layers. The isolated local suite proves every recovery
mechanism and refusal guard on every candidate. The remote Staging drill proves
the Cloudflare resource topology and operator execution for the same immutable
commit. A local pass is not represented as a remote drill.

## Automated isolated rehearsal

The ordered policy is [config/release-rehearsal.json](../../config/release-rehearsal.json)
and the orchestrator is [scripts/release-rehearsal.mjs](../../scripts/release-rehearsal.mjs).
It covers migration, schema-compatible application rollback/roll-forward,
encrypted D1 backup/isolated restore, resumable R2 repair, and credential
rotation/revocation/recovery.

```sh
node scripts/release-rehearsal.mjs \
  --commit <full-candidate-commit> \
  --receipt .artifacts/rehearsals/<commit>.json
```

The mode-0600 receipt contains start/end/duration, validation and decision
point for every stage; it intentionally excludes stdout, content, resource
credentials and raw tokens. [Orchestrator tests](../../tests/ops/release-rehearsal.test.ts)
prove complete ordering, stop-on-failure, and receipt behavior.

## Remote Staging procedure

1. Record candidate commit, Worker name/domain, D1/R2/DO/Analytics/rate-limit
   resource IDs, operators and approvers. Confirm none equals Production.
2. Record D1 Time Travel bookmark and complete an encrypted independent backup.
3. Apply numbered migrations with `wrangler.staging.jsonc`; verify schema v5,
   publish/read/conflict and historical hashes.
4. Deploy the candidate. Roll back to the previous compatible Worker build,
   verify reads and denied writes, then roll forward to the candidate.
5. Restore the backup into a newly provisioned restore-only database. Compare
   schema, row counts, sampled hashes, authorized read and unauthorized write.
6. Remove a disposable Staging Blob, detect/freeze, run repair dry-run, execute
   with matching audit confirmation, resume if interrupted, and verify hash.
7. Rotate a test credential, verify grace expiry/revocation, then exercise owner
   recovery without logging any raw capability.
8. Run `pnpm verify` and the load smoke against the candidate; inspect alerts,
   latency/cost dashboards, and confirm no Missing Blob.

## Required remote receipt

| Path | Start/end/duration | Data validation | Decision point / result |
| --- | --- | --- | --- |
| Migration | Required | schema v5; idempotent ledger; hashes readable | Stop before app deploy on incompatibility |
| App rollback + roll-forward | Required | health/read/auth and immutable hashes both builds | Roll forward if schema/DO lifecycle is not backward compatible |
| D1 restore | Required | new DB ID; schema/rows/sample hashes/read/denied write | Never restore over source during drill |
| R2 repair | Required | finding/audit IDs; exact restored hash; Latest readable | Freeze writes if exact content cannot be restored |
| Token rotation | Required | active/grace/revoked/recovery timestamps | Immediate revoke on exposure |

Attach command receipts and dashboard/query links to the protected release
environment. Any missing duration, mismatched resource ID, failed validation,
or undocumented operator knowledge fails the rehearsal.
