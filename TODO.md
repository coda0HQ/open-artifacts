# Post-P0 backlog

The original version-picker TODO is complete: the Host Viewer renders an inlined, keyboard-accessible selector for immutable historical versions, including encrypted artifacts after unlock. Its behavior is covered by Worker and browser tests.

P0 work is tracked in `docs/project-plan.md`; release evidence is tracked in `docs/releases/p0-evidence.md`. Optional post-P0 ideas are intentionally limited to:

- version diff and review views;
- Artifact export/import and bulk migration;
- a provider-portability spike driven by a real second-platform requirement;
- public-service identity, moderation, privacy, billing, and compliance work under a separate ADR.

No backlog item may weaken immutable publication, Draft/Checkpoint semantics, CSP/opaque-origin isolation, authorization, quota, telemetry, or migration gates.
