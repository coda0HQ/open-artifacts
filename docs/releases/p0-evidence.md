# P0 release evidence pack

- Candidate: `v1.0.0-rc.1`
- Schema: `5`
- Protocol: `1`
- Fixed upstream baseline: `a03a8c3721dd0021c78ea24533d6f7a7f4af07b3`

This pack is an index to executable evidence, not a self-attestation. The
[immutable release workflow](../../.github/workflows/release.yml) rebuilds a
full commit, runs `pnpm verify`, and emits the manifest, CycloneDX SBOM,
checksums, and provenance. The [deployment workflow](../../.github/workflows/deploy.yml)
accepts only a full commit and runs migrations before Worker deployment.

## Requirement evidence

| Requirement | Executable evidence | Operational evidence | Release interpretation |
| --- | --- | --- | --- |
| P0-REL-001 Atomic publication visibility | [publication model](../../tests/worker/publication-model.test.ts), [publication service](../../tests/worker/publication-service.test.ts), [failure injection](../../tests/failure-injection/publication.test.ts), [concurrency](../../tests/concurrency/publication.test.ts), [D1 CAS integration](../../tests/integration/d1-cas.test.ts) | [ADR 0004](../adr/0004-publication-commit-primitive.md), [partial publication runbook](../runbooks/partial-publication.md), [repair tests](../../tests/ops/repair.test.ts) | Latest advances only after verified immutable content and a committed D1 CAS; conflicts and replay are explicit. |
| P0-CI-001 Required delivery gates | [CI](../../.github/workflows/ci.yml), [release workflow](../../.github/workflows/release.yml), [environment tests](../../tests/ops/environments.test.ts), [release artifact tests](../../tests/ops/release-artifacts.test.ts) | [branch rules](../governance/branch-rules.md), [governance](../governance.md) | A clean full commit is required. GitHub branch/environment enforcement and non-author approval must be confirmed in the repository settings before promotion. |
| P0-SEC-001 Abuse resistance and bounded cost | [abuse tests](../../tests/security/abuse.test.ts), [quota tests](../../tests/security/quota.test.ts), [rate limiter tests](../../tests/worker/rate-limiter.test.ts), [load runner tests](../../tests/load/load-runner.test.ts), [kill-switch behavior](../../tests/worker/config.test.ts) | [authorization matrix](../security/authorization-matrix.md), [alerts](../ops/alerts.md), [capacity model](../ops/capacity-model.md), [canary policy](../../config/canary-policy.json) | Anonymous create/comments default off remotely; soft rate limits, exact quotas, budgets, alerts, and surface-specific kill switches bound cost. |
| P0-AUTH-001 Credential lifecycle | [credential service](../../tests/worker/credential-service.test.ts), [credential API](../../tests/worker/credentials-api.test.ts), [CLI credential command](../../tests/cli/credentials-command.test.ts), [secret store](../../tests/cli/secret-store.test.ts), [secret scan](../../tests/cli/secret-scan.test.ts) | [token-loss runbook](../runbooks/token-loss.md), [security review](../security/release-review.md) | Active/grace/revoked/recovery paths are tested; raw credentials are returned only at lifecycle boundaries and never committed. |
| P0-STATE-001 Crash-safe local agent state | [atomic-state kill points](../../tests/cli/atomic-state.test.ts), [concurrency](../../tests/cli/concurrency.test.ts), [file lock](../../tests/cli/file-lock.test.ts), [corruption recovery](../../tests/cli/state-corruption.test.ts), [permissions/secret store](../../tests/cli/secret-store.test.ts) | [CLI architecture](../architecture.md) | Lock ownership, fsync/rename, checksum, quarantine, and recovery protect the only write capability. |
| P0-MIG-001 Versioned schema and recovery | [migration suite](../../tests/worker/migration.test.ts), [schema compatibility](../../tests/worker/schema-compatibility.test.ts), [migration verifier](../../scripts/verify-migrations.mjs), [backup tests](../../tests/ops/backup.test.ts), [restore tests](../../tests/ops/restore.test.ts), [rehearsal orchestrator](../../tests/ops/release-rehearsal.test.ts) | [migration runbook](../runbooks/migrations.md), [restore runbook](../runbooks/restore.md), [rehearsal record](rehearsal.md) | Requests validate rather than mutate production schema. Remote promotion still requires a same-commit Staging restore receipt. |
| P0-VERS-001 Explicit version and Live semantics | [Live Draft API](../../tests/worker/live-draft-api.test.ts), [Draft service](../../tests/worker/live-draft-service.test.ts), [Live collaboration E2E](../../tests/e2e/live-collaboration.spec.ts), [copy-edit E2E](../../tests/e2e/live-copy-edit.spec.ts) | [ADR 0002](../adr/0002-live-version-semantics.md), [Live runbook](../runbooks/live.md) | Draft saves never mutate history; Checkpoint and rollback create new monotonically numbered immutable versions. |
| P0-TEST-001 Browser and boundary coverage | [Viewer behavior E2E](../../tests/e2e/viewer-behavior.spec.ts), [security boundaries E2E](../../tests/e2e/security-boundaries.spec.ts), [WCAG gate](../../tests/accessibility/viewer-accessibility.spec.ts), [bridge tests](../../tests/worker/bridge.test.ts), [CSP/Viewer tests](../../tests/worker/viewer.test.ts) | Browser failures upload screenshots, video, HTML report, and first-retry traces in [CI](../../.github/workflows/ci.yml). | Light/dark, 360 px, keyboard, reduced motion, WCAG 2.2 AA, opaque-origin and forged-message paths are automated with bounded retry. |
| P0-OPS-001 Observability and repair | [telemetry tests](../../tests/worker/telemetry.test.ts), [alert tests](../../tests/ops/alerts.test.ts), [backup/restore tests](../../tests/ops/backup.test.ts), [repair tests](../../tests/ops/repair.test.ts), [SLO tests](../../tests/ops/slo.test.ts) | [dashboards](../ops/dashboards.md), [alerts](../ops/alerts.md), [runbook index](../runbooks/README.md), [game day](../ops/game-day.md) | Bounded telemetry, P0/P1 alerts, dry-run/resumable repair, encrypted backup, and isolated restore are release-gated. |

## Candidate verification commands

```sh
pnpm verify
pnpm check:environments
pnpm exec wrangler deploy --dry-run --outdir dist/worker -c wrangler.production.jsonc
node scripts/build-release-artifacts.mjs \
  --bundle dist/worker --out dist --commit <full-commit> \
  --source-date-epoch <commit-epoch> --require-clean
(cd dist && sha256sum --check SHA256SUMS)
```

The command results belong in the immutable CI run and release artifact; they
must not be replaced by a manually edited “passed” checkbox.

The repository implementation run on 2026-08-04 completed `pnpm verify` with
Worker 465/465, CLI 189/189, Ops 43/43, DOM 23/23, migration 11/11 plus fresh
and repeat apply, and Chromium E2E 12/12. The production dependency audit found
no known vulnerabilities; the 529-file secret scan, protocol/runtime snapshots,
quality budgets, documentation links and all three remote-config dry-runs
passed. The immutable CI run must repeat these results after a candidate commit
exists.

## Promotion approvals

| Gate | Required evidence | State before external promotion |
| --- | --- | --- |
| Automated candidate | Green immutable Release workflow for the full commit | Required |
| Security | [Release review](../security/release-review.md), zero unaccepted High/Critical | Required |
| Staging | Signed [rehearsal](rehearsal.md) receipt with resource IDs and timings | Required |
| Non-author review | Reviewer identity and approval URL | Required; self-approval forbidden |
| Canary | Phase observations and alert/dashboard links from [canary plan](canary.md) | Required |

Absence of any row blocks Production; it is not converted into an exception by
this document.
