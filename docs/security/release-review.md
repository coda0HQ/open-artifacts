# Security release review

- Candidate: `v1.0.0-rc.1`
- Review scope: engine, CLI, Viewer/Frame, Live Durable Object, Cloudflare
  bindings, operator tools, CI and release supply chain.

## Review result

The repository control set has executable coverage for every High/Critical
entry in the [threat model](threat-model.md). The machine-readable
[dependency exception register](dependency-exceptions.json) is empty. A
Production promotion additionally requires a non-author Security reviewer to
link the immutable CI/audit run and sign the final table below; repository
authors must not manufacture that approval.

Local verification on 2026-08-04: `pnpm verify` passed; Worker 465, CLI 189,
Ops 43, DOM 23, migration 11 and Chromium E2E 12 tests were green. The
production dependency audit reported no known vulnerabilities and the secret
scan passed across 529 files. These results are reproducible implementation
evidence; the independent signature below remains a separate promotion gate.

| Review area | Evidence | Result required for promotion |
| --- | --- | --- |
| Threat model / authorization | [Threat model](threat-model.md), [authorization matrix test](../../tests/security/authorization-matrix.test.ts), [API authorizer tests](../../tests/worker/authorizer.test.ts) | No uncovered High/Critical threat and unknown operations deny by default. |
| Dependency audit | `pnpm audit:prod`, lockfile, Hono `>=4.12.34`, [CI audit job](../../.github/workflows/ci.yml) | Zero unaccepted High/Critical; every lesser accepted exception has owner and expiry. |
| Secrets | `pnpm scan:secrets`, [CLI scan tests](../../tests/cli/secret-scan.test.ts), environment policy | No raw token/key in source, state, argv, log, release metadata, or committed vars. |
| Frame / browser boundary | [security E2E](../../tests/e2e/security-boundaries.spec.ts), [bridge tests](../../tests/worker/bridge.test.ts), [Viewer tests](../../tests/worker/viewer.test.ts) | Opaque sandbox remains without same-origin; forged messages and stored markup cannot gain host authority. |
| Credential attack | [abuse tests](../../tests/security/abuse.test.ts), [credential lifecycle](../../tests/worker/credential-service.test.ts), [password tests](../../tests/security/password.test.ts) | Guessing is bounded, revoked/grace behavior is exact, client password never reaches the server. |
| Cross-artifact/private access | [authorization matrix](../../src/authorization-matrix.ts), [matrix tests](../../tests/security/authorization-matrix.test.ts), [API tests](../../tests/worker/api.test.ts) | Private existence is concealed and a credential is scoped to its artifact/channel. |
| Availability / cost | [rate tests](../../tests/worker/rate-limiter.test.ts), [quota tests](../../tests/security/quota.test.ts), [load smoke E2E](../../tests/e2e/load-smoke.spec.ts), [canary policy](../../config/canary-policy.json) | Rate, exact quota, cost budgets, alerts, and kill switches fail closed. |
| Supply chain | Pinned [CI](../../.github/workflows/ci.yml), [release workflow](../../.github/workflows/release.yml), [release artifact tests](../../tests/ops/release-artifacts.test.ts) | Full clean commit, frozen lock, reproducible manifest/SBOM/checksums/provenance. |

## Directed penetration cases

The release browser suite actively attempts a forged host message/request
proxy, stored comment markup execution, cross-surface unauthorized writes,
password guessing, private existence probing, oversized writes, invalid
protocol versions, idempotency replay/conflict, and rate/quota exhaustion.
Failures retain Playwright trace/video/screenshot evidence in CI; passing tests
are linked by exact source above, not represented by screenshots alone.

## Residual risk and disposition

- Cloudflare’s rate limiter is a soft distributed limiter; D1/DO quota ledgers
  remain the exact cost boundary.
- Password decryption is intentionally zero-knowledge, so server-side password
  attack detection is impossible; PBKDF2 and client backoff reduce but do not
  eliminate offline guessing risk.
- Remote Cloudflare resource provisioning, GitHub Environment controls, and
  organization identity adapters are deployment state. Production stays
  blocked until a reviewer verifies them against [environment policy](../../config/environment-policy.json).
- Team/invited use is supported. Public multi-tenant use remains outside P0.

## Independent approval

| Role | Reviewer (not author) | Immutable run / evidence URL | Decision | Time |
| --- | --- | --- | --- | --- |
| Security | Required | Required | Approve / reject | Required |
| Platform | Required | Required | Approve / reject | Required |

Blank cells mean “not approved”; they are not implicit acceptance.
