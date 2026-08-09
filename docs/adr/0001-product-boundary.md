# ADR 0001: First production product boundary

- Status: Accepted
- Date: 2026-08-04
- Owner: @Jiqize (interim Foundation maintainer)
- Review date: 2027-02-04

## Context

The audited upstream is a strong internal prototype, but its open-by-default
creation path, anonymous comments, implicit schema changes, and incomplete
operational controls are not suitable for an unrestricted public service.
Implementation needs a single conservative boundary while the P0 controls are
built and verified.

## Decision

The first supported production release is a private, team-scoped service for
invited users. It is not a public multi-tenant SaaS release.

- Public artifact reads are allowed only when an owner explicitly selects
  public visibility. Unlisted is the default visibility.
- Artifact creation requires an instance credential. Production fails closed
  when the creation policy or its credential source is absent.
- Anonymous comments are disabled. Comments require an authenticated actor and
  a credential authorized for the target artifact.
- The service must not be used for regulated or highly sensitive data until a
  separate compliance review approves the deployment and residency controls.
- The initial data placement preference is APAC, matching the primary operating
  team. A Cloudflare placement hint is not represented as a hard residency
  guarantee; any stronger requirement blocks launch until contractually met.

Default lifecycle policy:

| Data | Default retention | Deletion behavior |
| --- | --- | --- |
| Published versions | 365 days after last artifact activity | Hidden immediately; primary D1/R2 data purged within 24 hours |
| Live drafts | 7 days after last activity | Purged by the draft reconciler |
| Failed/expired publications and unreferenced blobs | 24-hour repair window | Purged after reconciliation confirms no committed reference |
| Security/audit events | 90 days | Purged by dated partitions or scheduled jobs |
| Encrypted backups | 90 days | Expire automatically; deletion requests age out with the final backup |

Owners can export manifest, metadata, and every committed version before
deletion. A deletion receipt records opaque identifiers and counts, never
artifact content or raw credentials.

## Consequences

- Public launch, anonymous participation, billing, and account self-service are
  explicitly outside P0.
- Routes and deployment profiles can make the private boundary stricter, but
  cannot silently broaden it.
- A public-service proposal requires a new ADR, abuse review, privacy review,
  capacity evidence, and updated retention/residency commitments.
