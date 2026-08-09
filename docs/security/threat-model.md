# Threat Model

- Status: Active
- Owner: Security / Platform
- Review cadence: each release and after any new public or realtime surface

## Scope and assets

Protected assets are immutable published content and its latest pointer, raw write/channel credentials, organization visibility boundaries, private artifact existence, Live drafts, comments and handoff media, D1/R2/DO availability, deployment credentials, and the operator audit trail. Availability and bounded spend are security properties for this service.

Trust zones are: an untrusted artifact frame with an opaque origin; the same-origin host chrome; public HTTP clients; authenticated CLI/owner clients; Worker domain services; D1 metadata; R2 blobs; Durable Object state; CI/deployment identities; and operator repair/restore tools. User artifact HTML, comment fields, handoff events, request headers and all browser messages are untrusted.

## Attackers

- Anonymous internet clients performing create, comment, connection or storage floods.
- A viewer of one artifact attempting cross-artifact reads or mutations.
- A malicious artifact script trying to reach host cookies, host fetch, or privileged message handlers.
- A holder of an old, revoked or leaked write capability.
- A compromised dependency, CI job or operator workstation seeking deployment secrets.
- Accidental operator actions against the wrong environment or partially published data.

## Data flows and controls

| Flow | Boundary | Principal threats | Required controls | Verification / owner |
| --- | --- | --- | --- | --- |
| CLI → Publish API | Internet → Worker | Spoofing, replay, oversized bodies, token disclosure | Bearer capability lifecycle, idempotency fingerprint, body cap, soft rate limit, exact quota, redaction | API, credential, abuse and quota tests / Platform |
| Worker → D1/R2 | Domain → storage | Partial publication, tampering, missing blob, pointer race | Immutable blob, read-back hash, Publication state machine, D1 CAS batch, reconciler | failure-injection/concurrency/reconcile suites / Platform |
| Viewer host → artifact frame | Trusted origin → opaque origin | Origin/source spoofing, arbitrary host fetch, stored script injection | sandbox without same-origin, strict CSP/nonce, source + schema allowlist, no generic proxy | bridge/host DOM security tests / Viewer |
| Viewer/CLI → Live DO | Internet → realtime state | connection flood, event injection, lost draft, stale overwrite | view/write matrix, rate + session quota, message allowlist, persisted revision/CAS/lease | Live protocol, DO restart and collaboration E2E / Realtime |
| Viewer → Comments/Handoff | Internet → D1/R2 | spam, stored injection, cost exhaustion, moderation bypass | anonymous off by default, text rendering, caps, rate/quota, author/owner delete tokens | abuse/injection and DOM tests / Security |
| Operator → reconcile/restore | Operator → production | elevation, destructive wrong target, unaudited repair | separate secret, 404 concealment, dry-run, confirmation/audit ID, environment ID checks, approval | runbooks and restore rehearsal / SRE |
| CI → deploy | GitHub → Cloudflare | supply-chain injection, secret leakage, unreviewed deploy | pinned Actions, required checks, secret scan, dependency audit, protected Environment/OIDC | CI and release evidence / Release owner |

## STRIDE register

| ID | Category | Threat / impact | Severity | Control and test | Owner |
| --- | --- | --- | --- | --- | --- |
| T-01 | Spoofing | Guess/reuse write token, including grace token after expiry | High | SHA-256-only storage, constant-time checks, active/grace/revoked lifecycle; credential tests | Security |
| T-02 | Tampering | D1 pointer advances while R2 content is absent or wrong | Critical | verified immutable blob then one D1 commit; missing blob fails closed; failure injection | Platform |
| T-03 | Repudiation | Repair, recovery or credential rotation cannot be attributed | High | actor/time/status metadata, structured audit IDs, confirmation gate | Platform/SRE |
| T-04 | Information disclosure | Private artifact existence or content leaks through error/cache/OG/frame | Critical | conceal with 404, view authorization, private no-store, opaque frame | Viewer/Security |
| T-05 | Denial of service | Create/comment/handoff/Live floods drive cost or exhaust storage | High | per-actor soft limiter plus D1 exact quotas; bounded inputs | Platform/SRE |
| T-06 | Elevation | Artifact message invokes arbitrary host fetch/mutation | Critical | exact source, opaque-origin protocol schema and operation allowlist; negative DOM tests | Viewer |
| T-07 | Tampering | Concurrent CLI writes lose the only token | Critical | owner lock, atomic rename/fsync, checksum and quarantine; process tests | CLI |
| T-08 | Disclosure | Raw secret appears in argv, logs, manifest, recipe or crash output | Critical | SecretStore, stdin to Keychain, centralized redaction, blocking scanner | CLI/Security |
| T-09 | Tampering | Stale Live editor overwrites a newer checkpoint | Critical | monotonic draft revision, base checkpoint CAS, immutable rollback copy | Realtime |
| T-10 | Denial of service | Client-side password guesses | Medium | PBKDF2 work factor and browser attempt backoff; password never reaches server | Viewer |
| T-11 | Supply chain | Vulnerable package or unpinned workflow gains CI authority | High | lockfile, prod audit, dependency review, pinned Action SHA, expiring exceptions | Release owner |
| T-12 | Operator error | Restore or migration targets production unexpectedly | Critical | isolated configs/IDs, validate-only runtime, backup, double approval and rehearsal | SRE |

No High/Critical item may ship without a linked automated test or an explicit, expiring risk acceptance. Residual risk: Cloudflare Rate Limiting is locally cached and may overshoot; it is never used for billing or total quota. Client-side password attempts cannot be observed by the server because the password is intentionally zero-knowledge.
