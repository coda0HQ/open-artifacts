# ADR 0003: Cloudflare-first platform boundary

- Status: Accepted
- Date: 2026-08-04
- Owner: @Jiqize (interim Foundation maintainer)
- Review date: 2027-02-04

## Context

The Worker relies on Cloudflare Workers, D1, R2, Durable Objects,
`HTMLRewriter`, and static-asset bindings. Pretending that a second provider is
only configuration would hide substantial engineering and operational work.

## Decision

Cloudflare is the only P0 production target and an accepted dependency for the
next 18 months. Portability means explicit seams and contract tests, not a
second production adapter in P0.

Domain and application services depend on narrow ports for metadata, blobs,
realtime coordination, rate limiting, quota accounting, time, and identifiers.
Cloudflare bindings are constructed in one composition root. Viewer use of
`HTMLRewriter` and Workers-specific streaming remains documented platform code.

A second-provider spike is triggered only when one of these is true:

- an approved customer requirement cannot be met on Cloudflare;
- verified monthly platform cost is at least 30% above an evaluated alternative
  for three consecutive months;
- a required region or compliance control is unavailable;
- platform reliability misses the confirmed SLO for two consecutive quarters
  due to a Cloudflare-specific constraint.

The spike must implement metadata, blob, clock, and identifier contracts and
publish a gap analysis for realtime, HTML rewriting, migration, backup, and
observability before any portability promise is made.

## Consequences

- P0 avoids a speculative multi-cloud abstraction while still preventing core
  publication rules from importing Cloudflare globals.
- Cloudflare behavior that cannot be abstracted honestly is named and tested at
  the adapter boundary.
- The portability decision is reviewed no later than 2027-02-04.
