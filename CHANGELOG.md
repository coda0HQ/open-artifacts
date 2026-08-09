# Changelog

All notable changes are documented here. The project follows semantic
versioning for tagged release candidates and releases.

## [Unreleased]

- Production promotion remains gated on an immutable commit, independent
  review, remote Staging rehearsal and Canary observation.

## [1.0.0-rc.1] — candidate

### Added

- Atomic-visible publication state machine, immutable content, idempotency,
  reconciliation and fault/concurrency contracts.
- Numbered D1 migrations v1–v5, schema compatibility checks, encrypted backup,
  isolated restore, resumable repair, telemetry/alerts/SLO/capacity runbooks.
- Crash-safe CLI state, secure credential lifecycle, versioned shared protocol,
  Live Draft/Checkpoint/rollback semantics, rate/quota/abuse controls.
- Deterministic Viewer runtime, decomposed Viewer/CLI/Cloudflare composition,
  accessibility gate, quality budgets and isolated environment configs.
- Reproducible release manifest, CycloneDX SBOM, checksums and provenance.

### Changed

- Hono is pinned at or above the security-fixed 4.12.34 release.
- Production anonymous create and comments default to disabled; remote runtime
  configuration fails closed when required bindings/policies/secrets are absent.
- Schema changes occur only in deployment migrations, never request handling.

### Security

- Opaque-origin sandbox/CSP/nonce boundary, message allowlist, secret scanning,
  dependency audit, exact quotas and operational kill switches are release gates.

[Unreleased]: docs/releases/p0-evidence.md
[1.0.0-rc.1]: docs/releases/v1.0.0-rc.1.md
