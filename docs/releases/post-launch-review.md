# Post-launch review — v1.0.0-rc.1

Schedule this review seven days after `general-team` reaches 100%. Do not fill
the evidence fields before the observation window ends.

## Release identity

| Field | Value |
| --- | --- |
| Full commit / manifest SHA-256 | Required |
| Schema / protocol | 5 / 1 |
| Canary start / full promotion / review time | Required |
| Release Manager / SRE / Security / Product | Required |

## Seven-day observations

Record SLO/error-budget consumption, publication/read/Live p95, Missing Blob,
alerts/incidents, D1/R2/DO/Analytics/rate-limit cost, quota/rate saturation,
support requests, restore/repair actions, security events, accessibility
reports, and upstream divergence. Link queries and incident records; use `0`
only when a query proving zero is linked.

## What changed

- Expected outcome versus measured user outcome.
- Which alert fired early, late, noisily or not at all.
- Whether capacity/cost assumptions matched the [capacity model](../ops/capacity-model.md).
- Any manual or undocumented step in migration, repair, rollback or support.
- Any upstream commit now worth selecting or permanently rejecting.

## Actions

| Action | Evidence / problem | Owner | Priority | Due date | Tracking URL | State |
| --- | --- | --- | --- | --- | --- | --- |
| Required after review | Required | Named person | P0/P1/P2 | YYYY-MM-DD | Required | Open |

The review is complete only when every finding is either an owned, dated action
or a documented no-action decision approved by the release and product owners.
