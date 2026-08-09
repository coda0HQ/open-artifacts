# Upstream Sync Rollback

Owner: Maintainer. Release approver: Tech Lead.

1. Stop promotion when an upstream synchronization changes protocol fixtures, CSP, migration behavior, publication invariants, or required checks unexpectedly.
2. Record the fork commit, fixed upstream baseline, selected upstream commits, generated diff, schema version, and failing test/trace. Do not merge a moving upstream branch directly.
3. If the sync has not shipped, revert only the reviewed sync commits with a normal revert commit; preserve unrelated local work and generated provenance.
4. If shipped, first determine whether migrations or Durable Object lifecycle changed. A code rollback is allowed only while the prior Worker supports the active schema and remains on the same DO lifecycle side. Otherwise disable the affected feature and roll forward.
5. Run protocol golden fixtures, Worker/CLI/Ops/DOM/E2E tests, secret scan, dependency audit, and budget checks on the rollback candidate. Verify historical content hashes and current Drafts.
6. Promote through Preview and Staging using the same immutable build. Keep Production stopped until telemetry and the canary artifact remain healthy for the agreed window.

Update `docs/upstream-sync.md` with the rejected commit, conflict decision, tests, and conditions for reconsideration. Never rewrite fork history to hide a failed sync.
