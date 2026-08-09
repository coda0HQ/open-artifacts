# ADR 0004: D1 batch + conditional update is the publication commit primitive

- Status: Accepted
- Date: 2026-08-04
- Owners: Platform / SRE
- Review: 2027-02-04

## Decision

Open Artifacts uses one D1 `batch()` as the visible publication commit. The batch:

1. conditionally inserts the immutable version row only when the Artifact pointer equals `expected_version`;
2. advances `artifacts.current_version` with the same compare-and-set predicate; and
3. changes the Publication from `blob_ready` to `committed`, or to `conflict` when the conditional insert did not occur.

The R2 object is written and verified before this batch. Readers only accept a version whose Publication is `committed`, so an R2 write alone is never visible.

An already-stale client `baseVersion` is rejected during preflight as `pending → conflict`, before any Blob write. A race that becomes stale only after preflight is resolved by the commit batch as `blob_ready → conflict`.

## Evidence

`tests/integration/d1-cas.test.ts` runs against Miniflare's real D1 implementation and proves:

- a constraint error in any statement rolls the whole batch back;
- stale CAS leaves `current_version` and the visible version set unchanged while recording `conflict`;
- the success path changes the version row, pointer, and Publication state in one batch.

Run with `pnpm test:worker -- tests/integration/d1-cas.test.ts` or as part of `pnpm verify`.

## Consequences

- A Durable Object serializer is not required for P0 publication commits.
- R2 may contain an unreferenced immutable object after CAS loss or interruption; reconciliation owns cleanup.
- Every new write path, including Channel and Live Checkpoint, must use this primitive rather than updating `current_version` directly.
