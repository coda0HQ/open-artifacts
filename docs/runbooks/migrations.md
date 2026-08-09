# Migration runbook

- Owner: Platform on-call
- Approver: Release Manager
- Last rehearsed locally: 2026-08-04

Production requests validate the exact schema version and never execute DDL. Numbered files in `migrations/` are the only production migration source.

## Order

1. Freeze writes for the target environment or confirm the migration is expand-only.
2. Record the deployed Commit, Worker version, D1 database ID, current `schema_meta.version`, and D1 Time Travel bookmark.
3. Export D1 to the environment's independent backup destination.
4. Apply migrations to Preview, run `pnpm verify`, and inspect schema/version.
5. Repeat for Staging and run publish/read/conflict/repair smoke tests.
6. Obtain Production Environment approval, then run `pnpm wrangler d1 migrations apply <database> --remote -c <production-config>`.
7. Deploy the application built from the same reviewed Commit and verify `/health/ready` plus a canary artifact.

Never reuse Preview, Staging, and Production database IDs. Never use `--remote` from an uncommitted worktree.

## Failure handling

- Before application deployment: stop, retain the old Worker, collect the migration log, and prefer a corrected forward migration.
- After an expand migration: the old Worker may continue while the correction is prepared.
- Incompatible/destructive change: restore to a new isolated D1 database using the recorded bookmark/export, validate it, then switch the binding through an approved deployment. Do not overwrite the source database during validation.
- Interrupted command: rerun `d1 migrations list`, then apply again. Wrangler's migration ledger skips completed files; migration files are immutable once released.

Logs may contain migration numbers and D1 result metadata, but never bindings, bearer tokens, secrets, content bodies, or credential hashes.
