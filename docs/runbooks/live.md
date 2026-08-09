# Live Durable Object runbook

- Owner: Realtime / SRE
- Last reviewed: 2026-08-04
- Applies to: Preview, Staging, and Production deployments that bind `LIVE_DO`

## Invariants

- `LiveObject` uses a SQLite-backed Durable Object namespace. Draft payloads,
  revisions, leases, and queued events live in DO SQLite; D1 stores only the
  searchable draft index and checkpoint audit.
- Each environment has its own Worker identity and therefore its own namespace.
  Preview, Staging, and Production must never reuse D1, R2, Worker names, routes,
  or secrets.
- This project uses Wrangler's declarative `exports` lifecycle. Do not add a
  legacy `migrations` array to the same configuration. Wrangler rejects the
  combination, and a Worker deployed with `exports` must not return to legacy
  migrations.
- Keep `LiveObject` exported from `src/index.ts`, bound as `LIVE_DO`, and declared
  with `storage: "sqlite"`. Storage backend changes are not in-place operations.
- A Draft is recoverable work, not a published version. Disabling Live must
  preserve the namespace. Never force-checkpoint Drafts during an incident.

The lifecycle rules above follow Cloudflare's current declarative class export
model: <https://developers.cloudflare.com/durable-objects/reference/durable-objects-migrations/>.

## Provision a new environment

1. Confirm the environment-specific Wrangler file has a unique Worker name,
   D1 database, R2 bucket, route, and required secrets.
2. Add the binding and declaration together:

   ```json
   {
     "durable_objects": {
       "bindings": [{ "name": "LIVE_DO", "class_name": "LiveObject" }]
     },
     "exports": {
       "LiveObject": { "type": "durable-object", "storage": "sqlite" }
     }
   }
   ```

3. Run `pnpm exec wrangler deploy --dry-run -c <environment-config>` and inspect
   the generated bindings. A dry run does not create the namespace.
4. Deploy with `wrangler deploy`, not `wrangler versions upload`; lifecycle
   reconciliation only happens during a deploy.
5. Save the `Durable Object exports reconciliation` output in the release
   evidence. On first deployment it must report `LiveObject` as created.
6. Apply D1 migrations before enabling traffic, then run the smoke test below.

## Smoke test

Use a disposable artifact in the target environment:

1. Publish version 1 and record its `/raw?v=1` bytes and digest.
2. Save Draft revision 1 with `PUT /api/artifacts/:id/live/draft`.
3. Refresh or reconnect and confirm `GET .../live/draft` returns revision 1.
4. Submit a stale `expectedRevision: 0`; require `409 REVISION_CONFLICT`.
5. Checkpoint revision 1; require published version 2.
6. Re-read `/raw?v=1`; its bytes and digest must match step 1.
7. Create a Draft based on version 2, publish an ordinary version 3, then
   attempt the Draft checkpoint. Require `409 CHECKPOINT_CONFLICT` and verify
   the Draft payload remains readable with state `conflict`.
8. Close all WebSockets and verify the exact Live-session quota returns to its
   previous value.

The local executable equivalent is:

```bash
pnpm vitest run tests/worker/live-draft-api.test.ts tests/worker/contracts/realtime-session-store-contract.test.ts
pnpm exec playwright test tests/e2e/live-collaboration.spec.ts --project=chromium
```

## Disable or roll back application code

- Kill switch: deploy a configuration without the `LIVE_DO` binding so Live
  routes return 404 and the viewer hides its control. Keep the `exports`
  declaration unless the intent is to delete data.
- Do not remove the live `exports.LiveObject` entry as an incident response.
  Reconciliation against an empty declaration is a lifecycle change, not a
  feature flag.
- Application rollback is safe only among versions on the same side of a DO
  lifecycle change. Cloudflare rollbacks cannot cross a lifecycle change; use
  a forward fix when the target predates namespace creation/rename/transfer.
- D1 application rollback must leave migration 0005 tables intact. Additive
  schema remains readable by the forward-fixed Worker.

## Rename the class

A rename is a planned control-plane change, never an emergency edit.

1. Back up D1/R2, record DO Point-in-Time Recovery bookmarks where available,
   stop canary promotion, and drain active Live sessions.
2. Add the new class name in code while retaining a compatibility export for
   the old name.
3. Declare the new class as live and the old entry as `state: "renamed"` with
   `renamed_to`. Update bindings in the same reviewed change.
4. Deploy to Preview, run the complete smoke test, then repeat in Staging.
5. Deploy Production in the approved maintenance window. Preserve the
   reconciliation output and object-count checks.
6. Remove the compatibility export only in a later release after every binding
   resolves the new class. Never create a second namespace and copy Drafts by
   hand.

## Delete the namespace

Deletion destroys Drafts and queues and needs explicit data-loss approval.

1. Disable Live and wait through the Draft retention window, or export the
   required recovery evidence.
2. Prove no Worker binding references the namespace.
3. Add the declarative deleted tombstone according to the current Cloudflare
   procedure and deploy it separately from application changes.
4. Verify deletion in the reconciliation output and retain the approval,
   timestamps, counts, and recovery decision.

## Incident triage

| Symptom | Check | Safe action |
| --- | --- | --- |
| Draft disappears after refresh | DO binding/class, `drafts` row, actor authorization | Disable new Live sessions; do not checkpoint; restore/forward-fix |
| Repeated revision conflicts | Current revision, actor hash, lease owner/expiry | Re-read and reapply; never add last-write-wins |
| Checkpoint conflict | Draft base and current artifact version | Preserve Draft; rebase through a new revision or discard explicitly |
| Viewer says Saving indefinitely | Agent heartbeat, Draft GET, WS events, rate/quota logs | Keep published version available; retry Draft read/save with the same CAS |
| Live-session quota remains consumed | WebSocket close/alarm logs and quota lease | Close stale sockets; run targeted reconciliation, not a quota-table edit |

## Rehearsal record

For each Preview/Staging lifecycle exercise, record: environment and unique
resource IDs, commit, Wrangler version, start/end time, reconciliation output,
artifact ID, revisions/versions and hashes, reconnect result, rollback or
forward-fix decision, operator, reviewer, and links to logs/traces. A blank
template belongs in `docs/releases/rehearsal.md`; this runbook is not itself
evidence that a remote rehearsal occurred.
