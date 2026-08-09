# Partial publication and missing Blob runbook

- Owner: Platform on-call
- Production execution approver: Release Manager

The reconciler detects stale `pending`/`blob_ready` Publications, committed rows with a missing Blob, and managed R2 objects whose Publication is absent or references another key. The command is dry-run by default. It walks every bounded page, writes an fsynced checkpoint and append-only JSONL audit log under `.artifacts/repair/`, and exits `2` if it was cancelled or stopped at `--max-pages`.

## Triage

```sh
export OPEN_ARTIFACTS_URL=https://staging.example.com
export OPEN_ARTIFACTS_REPAIR_TOKEN=... # secret manager injection; never shell history
node scripts/repair-publications.mjs \
  --audit-id incident-123 \
  --limit 100 \
  --delay-ms 250
```

Review every finding. A stale Publication can be expired; an orphan Blob can be deleted. A `missing_blob` is never auto-repaired because deletion or metadata fabrication could hide data loss.

## Execute

After approval, repeat with the exact reviewed audit ID twice:

```sh
node scripts/repair-publications.mjs \
  --execute --audit-id incident-123 --confirm incident-123 > execution.json
```

Execution first CAS-transitions stale metadata to `expired`, then removes its Blob. If another request already changed the state, the item is skipped. Orphan deletion and repeated runs are idempotent. `SIGINT` finishes the current request, records the returned cursor, and stops before another page. Continue the exact audit/mode/kind set with:

```sh
node scripts/repair-publications.mjs \
  --execute --audit-id incident-123 --confirm incident-123 --resume
```

Use `repair-storage.mjs` when the approved scope is only `missing_blob` and `orphan_blob`; it cannot expire Publications. Do not edit a checkpoint by hand. A completed checkpoint makes a repeated `--resume` a no-op.

For a missing committed Blob: stop writes to the Artifact, preserve D1/R2 evidence, search the independent backup by `blobKey` and `contentHash`, restore to an isolated key, verify the hash, and only then copy it to the expected immutable key. Escalate if no verified copy exists; never move Latest or synthesize content.
