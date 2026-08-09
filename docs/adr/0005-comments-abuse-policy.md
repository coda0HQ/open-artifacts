# ADR 0005: Comments Abuse and Moderation Policy

- Status: Accepted
- Date: 2026-08-04

## Decision

Production anonymous comments are disabled unless ANONYMOUS_COMMENTS=enabled is explicitly reviewed for that deployment. The default team deployment requires artifact write/session authority to post. Read access follows artifact visibility.

An explicitly anonymous deployment must keep the per-actor comment rate limit, exact per-artifact comment quota, byte/field validation, inert text rendering, per-comment delete capability and owner moderation. Public SaaS enablement additionally requires an external challenge and report/moderation queue supplied by the product adapter; the neutral engine does not pretend to provide human moderation.

Comment deletion is immediate in the serving store. Operational backups follow the deployment retention schedule; operators must document the legal deletion window. Comment bodies and authors are untrusted and are rendered through textContent, never HTML. Text anchors are rejected for encrypted versions because they could copy plaintext into server-visible metadata.

## Consequences

- A self-hosted development/test profile remains explicitly permissive.
- An owner browsing with a write-token query moves the token to local storage, removes it from the URL, and uses it for authenticated posting/moderation.
- Enabling anonymous production comments without challenge/report integration is an accepted deployment risk, not the project default.
