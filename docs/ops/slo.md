# Service level objectives

Status: Accepted operating policy for the invited-team release. Owner: Interim Foundation maintainer / SRE on-call. Review cadence: monthly and after every P0 incident. Measurement begins only after an environment has the complete telemetry binding and synthetic probes; missing telemetry is an outage, not an exclusion.

## Objectives and indicators

| Objective | SLI | Rolling target | Error budget |
| --- | --- | --- | --- |
| Availability | successful eligible Worker requests / eligible requests | 99.9% per 30 days | 0.1%, about 43.2 minutes in 30 days |
| Publication reliability | committed create/update/channel/checkpoint operations / accepted publication attempts | 99.5% per 30 days | 0.5% of accepted attempts |
| Content integrity | committed versions whose immutable Blob exists and matches the recorded hash | 100% | zero missing/corrupt versions |
| Read latency | p95 duration for successful Viewer/raw reads | ≤750 ms over 15-minute windows | 10% regression allowance only below ceiling |
| Publish latency | p95 duration for successful publish operations | ≤1,500 ms over 15-minute windows | 10% regression allowance only below ceiling |
| Live reliability | successful connect/draft/checkpoint/rollback operations / accepted Live operations | 99.0% per 30 days | 1%; expected CAS conflicts excluded |
| Recovery | latest independently encrypted D1 export and validated isolated restore | RPO ≤24 h; RTO ≤4 h | no missed daily backup; monthly restore drill |

Eligible availability requests exclude synthetic load tests, explicit maintenance announced at least 24 hours ahead, and client-controlled `401`, `403`, `404`, `409`, `413`, or `429`. They do not exclude dependency failure, migration incompatibility, telemetry silence, Worker exceptions, or missing content. Publication conflicts, idempotent replays, rate limits, and exact quota rejections are counted separately and are not publish failures when they return the documented structure.

Analytics Engine fields and queries follow `docs/ops/dashboards.md`. Structured logs provide request/publication/trace correlation but never replace aggregate SLIs. SLI calculation is versioned with this document; changing the denominator requires the same review as changing the target.

## Error-budget policy

- Below 50% budget consumption at the midpoint: normal delivery, with reliability review for any sharp burn.
- At or above 50% at the midpoint, or a 14.4× one-hour burn: pause risky feature promotion and assign an owner to the largest contributor.
- At or above 75%, or a 6× six-hour burn: freeze non-reliability production changes and run a Game Day for the failing path.
- Exhausted budget or any Missing Blob: only incident mitigation, security fixes, rollback/roll-forward, and reliability work may deploy until the rolling window recovers and the owner approves unfreeze.

Planned maintenance consumes no availability budget only when announced, bounded, and excluded by an immutable event marker. Excess duration and user-visible integrity failures always count.

## Paging and ownership

`config/observability/alerts.json` maps each symptom to a severity, owner, threshold rationale, and runbook. P0 pages immediately; acknowledge within 15 minutes and establish containment within 60 minutes. P1 is acknowledged within 30 minutes and mitigated within four hours. A P1 becomes P0 when it affects immutable history, authorization boundaries, broad reads, restore ability, or the fast-burn threshold.

The primary on-call may disable anonymous surfaces, Live, Handoff, or all writes using reviewed kill switches. Deleting data, overwriting D1, crossing a Durable Object lifecycle change, broad quota increases, and Production promotion require the independent approver defined in governance.

## Recovery evidence

RPO is the interval from the manifest's `createdAt` to the incident cutoff. RTO runs from incident declaration to a validated service on an isolated/new database or an approved in-place recovery. A restore counts only after schema, row counts, sampled immutable hashes, a Viewer read, and unauthorized-write rejection pass. Record both values in `docs/releases/rehearsal.md`; workflow completion alone is not a restore drill.
