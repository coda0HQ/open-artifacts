# Missing Blob

Owner: Platform on-call. Severity: P0 when a committed version is unreadable.

1. Freeze create, update, checkpoint, and GC with the write kill switch; keep known-good reads enabled.
2. Capture the request ID, artifact ID, publication ID, version, expected content hash, and immutable blob key from structured logs. Never paste bearer tokens or content into the incident channel.
3. Run `repair-storage.mjs` in dry-run mode with a new audit ID. Confirm whether the object is missing, corrupt, or merely unreferenced.
4. Recover the exact hash-matching object from the independent backup account. Do not synthesize bytes, reuse a mutable key, or move Latest first.
5. Re-run the integrity scan. If recovery is impossible, atomically point Latest to the newest verified committed version and preserve the damaged row for forensics.
6. Resume writes only after the `missing_blob` metric is zero for 15 minutes and a second operator reviews the audit record.

Escalate to Security if deletion was unauthorized. Preserve logs, R2 audit events, and repair receipts for 90 days.
