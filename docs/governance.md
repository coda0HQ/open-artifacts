# Foundation governance

## Ownership

Until a larger maintainer team is configured, @Jiqize is the interim merge,
release, security-triage, and on-call owner. CODEOWNERS makes that ownership
explicit; it does not replace independent review for security, migration, or
production changes.

Required independent review:

- authentication, authorization, credential storage, CSP, and frame bridge;
- migrations, publication commit rules, repair, backup, and restore;
- deployment workflows, production configuration, and release provenance.

No author may approve their own production deployment. If the repository has
only one maintainer, production promotion remains blocked until a second named
reviewer is assigned.

## Merge and release policy

`main` must remain deployable. Pull requests require the repository's `verify`
checks and CODEOWNER approval. Production releases require an immutable commit,
successful staging evidence, a production-environment approval, and a linked
release evidence pack. Emergency changes follow the same automated checks and
receive retrospective independent review within one business day.

## Support boundary

P0 supports invited teams on the Cloudflare topology described by ADR 0003.
Public multi-tenant operation, regulated data, and alternate providers are not
supported without a superseding ADR. Best-effort community support is provided
through repository issues; security reports follow `SECURITY.md`.

## Review cadence

Owners review access, branch rules, dependency exceptions, runbooks, SLOs, and
upstream drift monthly. ADRs list their own mandatory review dates.
