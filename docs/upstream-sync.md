# Upstream synchronization

## Pinned origin

Foundation work starts from `coda0HQ/open-artifacts` commit
`a03a8c3721dd0021c78ea24533d6f7a7f4af07b3`. The `upstream` remote must point
to `https://github.com/coda0HQ/open-artifacts.git`; implementation branches do
not merge a floating upstream default branch.

Until the maintained fork remote is created, foundation commits include:

```text
Upstream-Commit: a03a8c3721dd0021c78ea24533d6f7a7f4af07b3
```

## Monthly sync procedure

1. Fetch upstream tags and the proposed exact commit without merging.
2. Review upstream changes by surface: schema/storage, authorization/security,
   viewer/CSP, CLI state, Live protocol, tests, generated assets, and docs.
3. Create a dedicated sync branch and record the old/new commit pair.
4. Reapply changes in small, reviewable commits. Publication, migration,
   credential, and protocol conflicts are resolved against Foundation ADRs;
   upstream behavior never silently overrides a local invariant.
5. Regenerate only documented generated files, run `pnpm verify`, and attach
   dependency and protocol-diff evidence.
6. Merge through the normal required checks and CODEOWNER review.

## Rollback

If a sync regresses an invariant, revert the sync as a normal reviewed commit
or roll forward with a focused fix. Do not rewrite shared history. Database
changes follow the migration runbook and are never undone by application-code
rollback alone.

The interim sync owner is @Jiqize. Each accepted sync is recorded in release
notes with its exact upstream commit.
