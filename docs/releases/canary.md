# Canary and progressive promotion

The executable thresholds and approvals live in
[config/canary-policy.json](../../config/canary-policy.json); their tests are
[tests/ops/canary-policy.test.ts](../../tests/ops/canary-policy.test.ts).
Production remains invite-only with anonymous create/comments disabled.

Promote one immutable release manifest through `canary` (one internal team,
maximum 5%, at least 60 minutes), `expanded` (invited internal teams, maximum
25%, at least 4 hours), then `general-team` (100%, at least 24 hours before the
post-launch review window starts). Each phase needs its named human approvals.

Stop immediately for Missing Blob, authorization regression, schema mismatch,
telemetry silence, unexplained core-flow failure, publish success below 99.5%,
or unbounded cost/rate saturation. `KILL_SWITCH_WRITES` freezes all API writes;
`KILL_SWITCH_LIVE` and `KILL_SWITCH_COMMENTS` contain those surfaces while
preserving ordinary reads. Code rollback is allowed only when the previous
Worker supports the active schema and Durable Object lifecycle; otherwise
disable the surface and roll forward.

For every phase record commit/manifest checksum, cohort, start/end, request and
publication success, p95 latency, Missing Blob, auth/rate/quota/Live alerts,
estimated cost, core-flow E2E result, operator, approver and decision. A quiet
dashboard without a successful synthetic core flow is not evidence.
